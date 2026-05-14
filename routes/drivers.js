const express = require('express');
const User = require('../models/User');

const router = express.Router();

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildDriverView(driver, pickup) {
  const location = driver.currentLocation || {};
  const hasLocation = Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
  const distanceKm = pickup && hasLocation
    ? haversineKm(pickup.latitude, pickup.longitude, location.latitude, location.longitude)
    : null;

  return {
    id: driver._id,
    name: driver.name,
    email: driver.email,
    phone: driver.phone,
    avatarUrl: driver.avatarUrl,
    vehicleType: driver.vehicleType || 'car',
    vehicleName: driver.vehicleName || 'Available driver',
    plateNumber: driver.plateNumber || '—',
    rating: typeof driver.rating === 'number' ? driver.rating : 4.8,
    isOnline: Boolean(driver.isOnline),
    isApproved: Boolean(driver.isApproved),
    driverStatus: driver.driverStatus || 'offline',
    distanceKm: distanceKm == null ? null : Number(distanceKm.toFixed(2)),
    location: hasLocation
      ? {
          latitude: location.latitude,
          longitude: location.longitude,
          updatedAt: location.updatedAt || null,
        }
      : null,
    lastSeenAt: driver.currentLocation?.updatedAt || null,
  };
}

router.get('/available', async (req, res) => {
  try {
    const pickupLat = toNumber(req.query.pickupLat);
    const pickupLon = toNumber(req.query.pickupLon);
    const radiusKm = Math.max(1, Math.min(toNumber(req.query.radiusKm) || 12, 50));
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 8, 20));
    const vehicleType = (req.query.vehicleType || '').toString().trim().toLowerCase();

    const availabilityQuery = {
      role: 'driver',
      verified: true,
      isApproved: true,
      isOnline: true,
    };

    if (vehicleType) {
      availabilityQuery.vehicleType = new RegExp(`^${vehicleType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    }

    let drivers = await User.find(availabilityQuery).sort({ 'currentLocation.updatedAt': -1, createdAt: -1 }).lean();

    if (drivers.length === 0) {
      const legacyQuery = {
        role: 'driver',
        verified: true,
      };

      if (vehicleType) {
        legacyQuery.vehicleType = availabilityQuery.vehicleType;
      }

      drivers = await User.find(legacyQuery).sort({ 'currentLocation.updatedAt': -1, createdAt: -1 }).lean();
    }

    const pickup = Number.isFinite(pickupLat) && Number.isFinite(pickupLon)
      ? { latitude: pickupLat, longitude: pickupLon }
      : null;

    const normalizedDrivers = drivers
      .map((driver) => buildDriverView(driver, pickup))
      .filter((driver) => {
        if (!pickup || driver.distanceKm == null) {
          return true;
        }

        return driver.distanceKm <= radiusKm;
      })
      .sort((a, b) => {
        if (a.distanceKm == null && b.distanceKm == null) return 0;
        if (a.distanceKm == null) return 1;
        if (b.distanceKm == null) return -1;
        return a.distanceKm - b.distanceKm;
      })
      .slice(0, limit);

    return res.status(200).json({
      drivers: normalizedDrivers,
      count: normalizedDrivers.length,
      cached: false,
      pickup,
      radiusKm,
    });
  } catch (err) {
    console.error('Driver search error', err?.message || err);
    return res.status(500).json({ error: 'Failed to search drivers' });
  }
});

module.exports = router;