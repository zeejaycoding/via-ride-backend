const express = require('express');
const ScheduledRide = require('../models/ScheduledRide');
const User = require('../models/User');
const authRouter = require('./auth');

const router = express.Router();
const getAuthenticatedUser = authRouter.getAuthenticatedUser;

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

function parseRidePoint(point) {
  if (!point) return null;
  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
}

function normalizeStatus(status) {
  return (status || '').toString().trim().toLowerCase();
}

function isActiveRideStatus(status) {
  return ['requested', 'scheduled', 'offered', 'accepted', 'in_progress'].includes(normalizeStatus(status));
}

function serializeRide(ride, driver) {
  return {
    ...ride,
    driver: driver
      ? {
          _id: driver._id,
          name: driver.name,
          avatarUrl: driver.avatarUrl,
          vehicleType: driver.vehicleType,
          vehicleName: driver.vehicleName,
          plateNumber: driver.plateNumber,
          rating: driver.rating,
          isOnline: driver.isOnline,
          currentLocation: driver.currentLocation || null,
        }
      : null,
  };
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseScheduledAt(value) {
  if (!value) return null;
  const scheduledDate = new Date(value);
  return Number.isNaN(scheduledDate.getTime()) ? null : scheduledDate;
}

function canCancelRide(ride) {
  const requestedAt = ride?.requestedAt ? new Date(ride.requestedAt) : null;
  if (!requestedAt || Number.isNaN(requestedAt.getTime())) {
    return false;
  }

  const ageMs = Date.now() - requestedAt.getTime();
  return ageMs <= 3 * 60 * 1000;
}

async function findRideById(rideId) {
  if (!rideId) return null;
  return ScheduledRide.findById(rideId);
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
      rideKind: 'schedule',
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

router.post('/request', async (req, res) => {
  try {
    const rider = await getAuthenticatedUser(req, res);
    if (!rider) return;

    if (rider.role !== 'rider') {
      return res.status(403).json({ error: 'Only riders can request rides' });
    }

    const {
      pickup,
      destination,
      selectedVehicle,
      rideType,
      distanceKm,
      vehicleCount,
      riderName,
      riderAvatarUrl,
    } = req.body || {};

    const pickupLat = toNumber(pickup?.latitude);
    const pickupLon = toNumber(pickup?.longitude);
    const destinationLat = toNumber(destination?.latitude);
    const destinationLon = toNumber(destination?.longitude);

    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLon) || !Number.isFinite(destinationLat) || !Number.isFinite(destinationLon)) {
      return res.status(400).json({ error: 'Valid pickup and destination coordinates are required' });
    }

    const ride = await ScheduledRide.create({
      rider: rider._id,
      riderName: riderName || rider.name,
      riderAvatarUrl: riderAvatarUrl || rider.avatarUrl,
      rideKind: 'now',
      selectedVehicle: selectedVehicle || 'car',
      rideType: rideType || 'now',
      scheduledAt: new Date(),
      vehicleCount: Number.isFinite(Number(vehicleCount)) ? Number(vehicleCount) : undefined,
      pickup: {
        latitude: pickupLat,
        longitude: pickupLon,
        address: pickup?.address || 'Pickup location',
      },
      destination: {
        latitude: destinationLat,
        longitude: destinationLon,
        name: destination?.name || 'Destination',
        address: destination?.address || 'Destination address',
      },
      distanceKm: Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : undefined,
      status: 'requested',
      requestedAt: new Date(),
      rejectedByDrivers: [],
    });

    return res.status(201).json({ ride });
  } catch (err) {
    console.error('Ride request create error:', err);
    return res.status(500).json({ error: 'Failed to request ride' });
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

router.get('/driver/requests', async (req, res) => {
  try {
    const driver = await getAuthenticatedUser(req, res);
    if (!driver) return;

    if (driver.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can view ride requests' });
    }

    const radiusKm = Math.max(1, Math.min(toNumber(req.query.radiusKm) || 20, 50));
    const driverLocation = driver.currentLocation || {};
    const driverLat = Number(driverLocation.latitude);
    const driverLon = Number(driverLocation.longitude);
    const hasDriverLocation = Number.isFinite(driverLat) && Number.isFinite(driverLon);

    const rides = await ScheduledRide.find({
      status: 'requested',
      rideKind: 'now',
      acceptedBy: { $exists: false },
      rejectedByDrivers: { $ne: driver._id },
    })
      .sort({ requestedAt: -1, createdAt: -1 })
      .lean();

    const availableRides = rides
      .map((ride) => {
        const pickup = parseRidePoint(ride.pickup);
        const distanceKm = hasDriverLocation && pickup
          ? Number(haversineKm(driverLat, driverLon, pickup.latitude, pickup.longitude).toFixed(2))
          : null;
        return {
          ...ride,
          distanceKm,
        };
      })
      .filter((ride) => ride.distanceKm == null || ride.distanceKm <= radiusKm)
      .slice(0, 10);

    return res.status(200).json({
      rides: availableRides,
      count: availableRides.length,
      radiusKm,
      driverLocation: hasDriverLocation ? { latitude: driverLat, longitude: driverLon } : null,
    });
  } catch (err) {
    console.error('Ride request fetch error:', err);
    return res.status(500).json({ error: 'Failed to load ride requests' });
  }
});

router.get('/driver/current', async (req, res) => {
  try {
    const driver = await getAuthenticatedUser(req, res);
    if (!driver) return;

    if (driver.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can view assigned rides' });
    }

    const ride = await ScheduledRide.findOne({
      acceptedBy: driver._id,
      status: { $in: ['accepted', 'in_progress'] },
    })
      .sort({ acceptedAt: -1, updatedAt: -1 })
      .lean();

    if (!ride) {
      return res.status(200).json({ ride: null });
    }

    const rider = await User.findById(ride.rider).lean();

    return res.status(200).json({
      ride: {
        ...ride,
        rider: rider
          ? {
              _id: rider._id,
              name: rider.name,
              avatarUrl: rider.avatarUrl,
            }
          : ride.rider,
      },
    });
  } catch (err) {
    console.error('Driver current ride error:', err);
    return res.status(500).json({ error: 'Failed to load assigned ride' });
  }
});

router.get('/rider/current', async (req, res) => {
  try {
    const rider = await getAuthenticatedUser(req, res);
    if (!rider) return;

    if (rider.role !== 'rider') {
      return res.status(403).json({ error: 'Only riders can view their ride' });
    }

    const ride = await ScheduledRide.findOne({
      rider: rider._id,
      rideKind: 'now',
      status: { $in: ['requested', 'accepted', 'in_progress'] },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    if (!ride) {
      return res.status(200).json({ ride: null });
    }

    let driver = null;
    if (ride.acceptedBy) {
      driver = await User.findById(ride.acceptedBy).lean();
    }

    return res.status(200).json({ ride: serializeRide(ride, driver) });
  } catch (err) {
    console.error('Rider current ride error:', err);
    return res.status(500).json({ error: 'Failed to load ride status' });
  }
});

router.patch('/:rideId/cancel', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const isRider = String(ride.rider) === String(user._id);
    const isAssignedDriver = String(ride.acceptedBy || '') === String(user._id);

    if (!isRider && !isAssignedDriver) {
      return res.status(403).json({ error: 'You are not allowed to cancel this ride' });
    }

    if (!['requested', 'accepted'].includes(ride.status)) {
      return res.status(409).json({ error: 'This ride can no longer be cancelled' });
    }

    if (!canCancelRide(ride)) {
      return res.status(409).json({ error: 'Ride cancellation window has expired' });
    }

    ride.status = 'cancelled';
    ride.cancelledAt = new Date();
    ride.cancelledBy = user._id;
    await ride.save();

    const driver = ride.acceptedBy ? await User.findById(ride.acceptedBy).lean() : null;
    return res.status(200).json({ ride: serializeRide(ride.toObject(), driver) });
  } catch (err) {
    console.error('Ride cancel error:', err);
    return res.status(500).json({ error: 'Failed to cancel ride' });
  }
});

router.patch('/:rideId/accept', async (req, res) => {
  try {
    const driver = await getAuthenticatedUser(req, res);
    if (!driver) return;

    if (driver.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can accept rides' });
    }

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (ride.status !== 'requested' || ride.acceptedBy) {
      return res.status(409).json({ error: 'Ride is no longer available' });
    }

    const riderRequestedVehicle = (ride.selectedVehicle || 'car').toString().toLowerCase();
    const driverVehicle = (driver.vehicleType || '').toString().toLowerCase();
    if (driverVehicle && riderRequestedVehicle && driverVehicle !== riderRequestedVehicle) {
      return res.status(403).json({ error: 'This ride is not for your vehicle type' });
    }

    ride.status = 'accepted';
    ride.acceptedBy = driver._id;
    ride.acceptedAt = new Date();
    await ride.save();

    return res.status(200).json({ ride: ride.toObject() });
  } catch (err) {
    console.error('Ride accept error:', err);
    return res.status(500).json({ error: 'Failed to accept ride' });
  }
});

router.patch('/:rideId/reject', async (req, res) => {
  try {
    const driver = await getAuthenticatedUser(req, res);
    if (!driver) return;

    if (driver.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can reject rides' });
    }

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (!Array.isArray(ride.rejectedByDrivers)) {
      ride.rejectedByDrivers = [];
    }

    if (!ride.rejectedByDrivers.some((id) => String(id) === String(driver._id))) {
      ride.rejectedByDrivers.push(driver._id);
    }

    if (ride.status === 'requested' && !ride.acceptedBy) {
      ride.status = 'requested';
    }

    await ride.save();
    return res.status(200).json({ ride: ride.toObject() });
  } catch (err) {
    console.error('Ride reject error:', err);
    return res.status(500).json({ error: 'Failed to reject ride' });
  }
});

router.patch('/:rideId/start', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const isRider = String(ride.rider) === String(user._id);
    const isAssignedDriver = String(ride.acceptedBy || '') === String(user._id);

    if (!isRider && !isAssignedDriver) {
      return res.status(403).json({ error: 'You are not allowed to start this ride' });
    }

    if (ride.status !== 'accepted') {
      return res.status(409).json({ error: 'Ride is not ready to start' });
    }

    ride.status = 'in_progress';
    ride.startedAt = new Date();
    await ride.save();

    return res.status(200).json({ ride: ride.toObject() });
  } catch (err) {
    console.error('Ride start error:', err);
    return res.status(500).json({ error: 'Failed to start ride' });
  }
});

router.patch('/:rideId/complete', async (req, res) => {
  try {
    const driver = await getAuthenticatedUser(req, res);
    if (!driver) return;

    if (driver.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can complete rides' });
    }

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    if (String(ride.acceptedBy || '') !== String(driver._id)) {
      return res.status(403).json({ error: 'You are not assigned to this ride' });
    }

    ride.status = 'completed';
    ride.completedAt = new Date();
    await ride.save();

    return res.status(200).json({ ride: ride.toObject() });
  } catch (err) {
    console.error('Ride complete error:', err);
    return res.status(500).json({ error: 'Failed to complete ride' });
  }
});

module.exports = router;