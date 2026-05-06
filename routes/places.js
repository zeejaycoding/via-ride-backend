const express = require('express');
const axios = require('axios');

const router = express.Router();

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

function buildCacheKey(query, ll) {
  return `${query.toLowerCase()}|${ll || ''}`;
}

function normalizeCenter(ll) {
  if (!ll) return null;
  const [lat, lon] = ll.split(',').map((value) => Number(value.trim()));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { latitude: lat, longitude: lon };
  }
  return null;
}

function pickAddress(parts, fallback) {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? filtered.join(', ') : fallback;
}

function toPhotonSuggestion(feature) {
  const coordinates = feature?.geometry?.coordinates || [];
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const props = feature?.properties || {};
  const name = props.name || props.street || props.city || props.state || props.country || 'Suggested place';
  const address = pickAddress(
    [props.street, props.city, props.state, props.country],
    props.name || name,
  );

  return {
    id: String(props.osm_id || `${name}-${latitude}-${longitude}`),
    name,
    address,
    latitude,
    longitude,
    displayName: address,
  };
}

function toNominatimSuggestion(item) {
  const latitude = Number(item.lat);
  const longitude = Number(item.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const addressParts = [
    item.address?.road,
    item.address?.city || item.address?.town || item.address?.village,
    item.address?.state,
    item.address?.country,
  ];

  const name = item.name || item.display_name.split(',')[0] || 'Suggested place';
  const address = pickAddress(addressParts, item.display_name);

  return {
    id: String(item.place_id),
    name,
    address,
    latitude,
    longitude,
    displayName: item.display_name,
  };
}

async function searchGooglePlaces(query, center) {
  const params = new URLSearchParams();
  params.set('query', query);
  params.set('key', process.env.GOOGLE_MAPS_API_KEY);
  if (center) {
    params.set('location', `${center.latitude},${center.longitude}`);
    params.set('radius', '50000');
  }

  const response = await axios.get(`https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`, {
    timeout: 10000,
  });

  const results = response.data?.results || [];
  return results.slice(0, 6).map(item => {
    return {
      id: item.place_id,
      name: item.name,
      address: item.formatted_address,
      latitude: item.geometry?.location?.lat,
      longitude: item.geometry?.location?.lng,
      displayName: item.formatted_address || item.name,
    };
  }).filter(item => item.latitude && item.longitude);
}

router.get('/search', async (req, res) => {
  try {
    const query = (req.query.q || '').toString().trim();
    const ll = (req.query.ll || '').toString().trim();

    if (!query || query.length < 3) {
      return res.status(400).json({ error: 'q is required' });
    }

    const cacheKey = buildCacheKey(query, ll);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.status(200).json({ results: cached.results, cached: true, provider: cached.provider });
    }

    const center = normalizeCenter(ll);

    let results = [];
    let provider = 'google_maps';

    try {
      if (!process.env.GOOGLE_MAPS_API_KEY) {
        throw new Error('GOOGLE_MAPS_API_KEY is not configured');
      }
      results = await searchGooglePlaces(query, center);
    } catch (googleError) {
      console.error('Google Places search failed:', googleError.message);
      return res.status(502).json({ error: 'Search provider failed' });
    }

    cache.set(cacheKey, {
      results,
      provider,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return res.status(200).json({ results, cached: false, provider });
  } catch (err) {
    const status = err?.response?.status || 500;
    const message = err?.response?.data?.message || err.message || 'Search failed';
    console.error('Places search error:', status, message);
    return res.status(status).json({ error: message });
  }
});

module.exports = router;