const express = require('express');
const axios = require('axios');
const {
  calculateCancellationFee,
  calculateFare,
  calculateVehicleDuration,
  resolveProfile,
  resolveSurgeMultiplier,
} = require('../lib/pricing');

const router = express.Router();

const CACHE_TTL_MS = 5 * 1000; // short TTL for realtime feel
const cache = new Map();

function buildCacheKey(origin, destination, countryCode, region, surge) {
  return `${origin}|${destination}|${(countryCode || '').toString().toUpperCase()}|${(region || '').toString().toUpperCase()}|${(surge || '').toString()}`;
}

function kmFromMeters(m) {
  return Math.max(0, Number(m) / 1000);
}

function minFromSeconds(s) {
  return Math.max(0, Number(s) / 60);
}

const VEHICLE_TIERS = [
  { id: 'car', name: 'Car' },
  { id: 'van', name: 'Van' },
  { id: 'bike', name: 'Bike' },
];

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

router.get('/estimate', async (req, res) => {
  try {
    const origin = (req.query.origin || '').toString(); // 'lat,lon'
    const destination = (req.query.destination || '').toString();
    const countryCode = (req.query.countryCode || req.query.country || '').toString();
    const region = (req.query.region || '').toString();
    const surge = req.query.surge;

    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });

    const cacheKey = buildCacheKey(origin, destination, countryCode, region, surge);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.status(200).json({ ...cached.value, cached: true });
    }

    // parse lat,lon
    const [olat, olon] = origin.split(',').map((v) => v.trim());
    const [dlat, dlon] = destination.split(',').map((v) => v.trim());

    // Query Google Maps Directions API for driving route (distance in meters, duration in seconds)
    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${olat},${olon}&destination=${dlat},${dlon}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const resp = await axios.get(directionsUrl, { timeout: 8000 });
    const route = resp.data?.routes?.[0]?.legs?.[0];
    if (!route) return res.status(502).json({ error: 'No route found' });

    const distanceKm = kmFromMeters(route.distance.value);
    const durationMin = Math.ceil(minFromSeconds(route.duration.value));
    const overviewPolyline = resp.data?.routes?.[0]?.overview_polyline?.points || '';
    const profile = resolveProfile({ countryCode, region });
    const surgeInfo = resolveSurgeMultiplier(surge);

    const vehicles = VEHICLE_TIERS.map((t) => {
      const estimatedDurationMin = calculateVehicleDuration(durationMin, t.id);
      const fare = calculateFare({
        vehicleId: t.id,
        distanceKm,
        durationMin: estimatedDurationMin,
        countryCode,
        region,
        surge,
      });
      return {
        id: t.id,
        name: t.name,
        baseFare: fare.baseFare,
        perKm: fare.perKm,
        perMin: fare.perMin,
        minimumFare: fare.minimumFare,
        distanceKm: Number(distanceKm.toFixed(3)),
        durationMin: estimatedDurationMin,
        region: fare.region,
        currency: fare.currency,
        surgeLevel: fare.surgeLevel,
        surgeMultiplier: fare.surgeMultiplier,
        estimatedFare: fare.fare,
        breakdown: fare.breakdown,
      };
    });

    const value = {
      countryCode: countryCode ? countryCode.toUpperCase() : null,
      region: profile.label,
      currency: profile.currency,
      surgeLevel: surgeInfo.level,
      surgeMultiplier: surgeInfo.multiplier,
      polylinePoints: overviewPolyline,
      cancellationPolicy: {
        freeUntilMinutes: 3,
        feeRange: { min: 1, max: 2 },
      },
      distanceKm: Number(distanceKm.toFixed(3)),
      durationMin,
      vehicles,
    };
    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });

    return res.status(200).json({ ...value, cached: false });
  } catch (err) {
    console.error('Trip estimate error', err?.message || err);
    return res.status(500).json({ error: 'Failed to estimate trip' });
  }
});

router.post('/final-fare', (req, res) => {
  try {
    const vehicleId = (req.body.vehicleId || 'car').toString();
    const actualDistanceKm = req.body.actualDistanceKm ?? (req.body.actualDistanceMeters != null ? Number(req.body.actualDistanceMeters) / 1000 : 0);
    const actualDurationMin = req.body.actualDurationMin ?? (req.body.actualDurationSeconds != null ? Number(req.body.actualDurationSeconds) / 60 : 0);
    const countryCode = (req.body.countryCode || req.body.country || '').toString();
    const region = (req.body.region || '').toString();
    const surge = req.body.surge;

    const fare = calculateFare({
      vehicleId,
      distanceKm: toNumber(actualDistanceKm),
      durationMin: toNumber(actualDurationMin),
      countryCode,
      region,
      surge,
    });

    return res.status(200).json({
      tripType: 'final',
      actualDistanceKm: roundTripValue(actualDistanceKm),
      actualDurationMin: roundTripValue(actualDurationMin),
      ...fare,
    });
  } catch (err) {
    console.error('Final fare error', err?.message || err);
    return res.status(400).json({ error: err?.message || 'Failed to calculate final fare' });
  }
});

router.get('/cancellation-fee', (req, res) => {
  const minutesSinceBooking = req.query.minutesSinceBooking;
  const policy = calculateCancellationFee(minutesSinceBooking);

  return res.status(200).json({
    freeUntilMinutes: policy.freeUntilMinutes,
    fee: policy.fee,
    currency: 'USD',
  });
});

function roundTripValue(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 1000) / 1000;
}

module.exports = router;
