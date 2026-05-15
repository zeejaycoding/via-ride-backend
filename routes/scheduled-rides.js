const express = require('express');
const ScheduledRide = require('../models/ScheduledRide');
const authRouter = require('./auth');

const router = express.Router();
const getAuthenticatedUser = authRouter.getAuthenticatedUser;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseScheduledAt(value) {
  if (!value) return null;
  const scheduledDate = new Date(value);
  return Number.isNaN(scheduledDate.getTime()) ? null : scheduledDate;
}

router.post('/', async (req, res) => {
  try {
    const rider = await getAuthenticatedUser(req, res);
    if (!rider) return;

    if (rider.role !== 'rider') {
      return res.status(403).json({ error: 'Only riders can schedule rides' });
    }

    const { pickup, destination, scheduledAt, riderName, riderAvatarUrl, rideType, distanceKm } = req.body || {};
    const scheduledDate = parseScheduledAt(scheduledAt);

    if (!pickup || !destination || !scheduledDate) {
      return res.status(400).json({ error: 'pickup, destination, and scheduledAt are required' });
    }

    if (scheduledDate.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'scheduledAt must be in the future' });
    }

    const pickupLat = toNumber(pickup.latitude);
    const pickupLon = toNumber(pickup.longitude);
    const destinationLat = toNumber(destination.latitude);
    const destinationLon = toNumber(destination.longitude);

    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLon) || !Number.isFinite(destinationLat) || !Number.isFinite(destinationLon)) {
      return res.status(400).json({ error: 'Valid pickup and destination coordinates are required' });
    }

    const scheduledRide = await ScheduledRide.create({
      rider: rider._id,
      riderName: riderName || rider.name,
      riderAvatarUrl: riderAvatarUrl || rider.avatarUrl,
      pickup: {
        latitude: pickupLat,
        longitude: pickupLon,
        address: pickup.address || 'Pickup location',
      },
      destination: {
        latitude: destinationLat,
        longitude: destinationLon,
        name: destination.name || 'Destination',
        address: destination.address || 'Destination address',
      },
      rideType: rideType || 'schedule',
      scheduledAt: scheduledDate,
      distanceKm: Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : undefined,
      status: 'scheduled',
    });

    return res.status(201).json({ scheduledRide });
  } catch (err) {
    console.error('Scheduled ride create error:', err);
    return res.status(500).json({ error: 'Failed to schedule ride' });
  }
});

router.get('/driver/available', async (req, res) => {
  try {
    const driver = await getAuthenticatedUser(req, res);
    if (!driver) return;

    if (driver.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can view scheduled rides' });
    }

    if (!driver.isApproved || !driver.futureRideAccess) {
      return res.status(403).json({ error: 'Driver is not approved for scheduled rides' });
    }

    const upcomingRides = await ScheduledRide.find({
      status: 'scheduled',
      scheduledAt: { $gte: new Date() },
    })
      .sort({ scheduledAt: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      rides: upcomingRides,
      count: upcomingRides.length,
    });
  } catch (err) {
    console.error('Scheduled ride driver fetch error:', err);
    return res.status(500).json({ error: 'Failed to load scheduled rides' });
  }
});

module.exports = router;