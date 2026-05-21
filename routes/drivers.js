const express = require('express');
const User = require('../models/User');
const ScheduledRide = require('../models/ScheduledRide');
const authRouter = require('./auth');
const { calculateFare } = require('../lib/pricing');

const router = express.Router();
const getAuthenticatedUser = authRouter.getAuthenticatedUser;

function getTodayKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfToday(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfToday(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

function normalizeOnlineStats(user, now) {
  const todayKey = getTodayKey(now);
  if (user.onlineStatsDate === todayKey) {
    return;
  }

  user.onlineStatsDate = todayKey;
  user.onlineSecondsToday = 0;
  if (user.isOnline) {
    user.onlineSince = now;
  }
}

function computeOnlineSecondsToday(user, now) {
  const persisted = Number(user.onlineSecondsToday) || 0;
  if (!user.isOnline || !user.onlineSince) {
    return persisted;
  }

  const sinceMs = new Date(user.onlineSince).getTime();
  if (!Number.isFinite(sinceMs)) {
    return persisted;
  }

  return persisted + Math.max(0, Math.floor((now.getTime() - sinceMs) / 1000));
}

function formatDurationHours(seconds) {
  const hours = seconds / 3600;
  return `${hours.toFixed(1)}h`;
}

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

router.get('/me/dashboard', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    if (user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can access dashboard stats' });
    }

    const now = new Date();
    normalizeOnlineStats(user, now);
    await user.save();

    const dayStart = startOfToday(now);
    const dayEnd = endOfToday(now);

    const completedRides = await ScheduledRide.find({
      acceptedBy: user._id,
      status: 'completed',
      updatedAt: { $gte: dayStart, $lt: dayEnd },
    }).lean();

    const ridesToday = completedRides.length;
    const onlineSecondsToday = computeOnlineSecondsToday(user, now);

    const vehicleId = (user.vehicleType || 'car').toString().toLowerCase();
    const earningsToday = completedRides.reduce((sum, ride) => {
      const distanceKm = Number.isFinite(Number(ride.distanceKm)) ? Number(ride.distanceKm) : 0;
      const durationMin = Math.max(1, distanceKm * 3);
      const fare = calculateFare({
        vehicleId,
        distanceKm,
        durationMin,
      });
      return sum + (Number(fare.fare) || 0);
    }, 0);

    return res.status(200).json({
      earningsToday: Number(earningsToday.toFixed(2)),
      ridesToday,
      rating: typeof user.rating === 'number' ? Number(user.rating.toFixed(1)) : 0,
      onlineSecondsToday,
      onlineTimeLabel: formatDurationHours(onlineSecondsToday),
      isOnline: Boolean(user.isOnline),
      isApproved: Boolean(user.isApproved),
      driverStatus: user.driverStatus || (user.isOnline ? 'online' : 'offline'),
      updatedAt: now.toISOString(),
    });
  } catch (err) {
    console.error('Driver dashboard error', err?.message || err);
    return res.status(500).json({ error: 'Failed to load driver dashboard stats' });
  }
});

router.patch('/me/location', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    if (user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can update location' });
    }

    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }

    user.currentLocation = {
      latitude,
      longitude,
      updatedAt: new Date(),
    };

    await user.save();

    return res.status(200).json({
      currentLocation: user.currentLocation,
      updatedAt: user.currentLocation.updatedAt,
    });
  } catch (err) {
    console.error('Driver location update error', err?.message || err);
    return res.status(500).json({ error: 'Failed to update driver location' });
  }
});

router.patch('/me/status', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    if (user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can update status' });
    }

    const requestedOnline = Boolean(req.body?.isOnline);
    const now = new Date();

    normalizeOnlineStats(user, now);

    if (!requestedOnline && user.isOnline && user.onlineSince) {
      const sessionSeconds = Math.max(0, Math.floor((now.getTime() - new Date(user.onlineSince).getTime()) / 1000));
      user.onlineSecondsToday = (Number(user.onlineSecondsToday) || 0) + sessionSeconds;
      user.onlineSince = undefined;
    }

    if (requestedOnline && !user.isOnline) {
      user.onlineSince = now;
    }

    user.isOnline = requestedOnline;
    user.driverStatus = requestedOnline ? 'online' : 'offline';
    await user.save();

    const onlineSecondsToday = computeOnlineSecondsToday(user, now);

    return res.status(200).json({
      isOnline: Boolean(user.isOnline),
      driverStatus: user.driverStatus,
      onlineSecondsToday,
      onlineTimeLabel: formatDurationHours(onlineSecondsToday),
      updatedAt: now.toISOString(),
    });
  } catch (err) {
    console.error('Driver status update error', err?.message || err);
    return res.status(500).json({ error: 'Failed to update driver status' });
  }
});

module.exports = router;