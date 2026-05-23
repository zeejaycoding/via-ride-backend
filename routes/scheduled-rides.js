const express = require('express');
const ScheduledRide = require('../models/ScheduledRide');
const User = require('../models/User');
const authRouter = require('./auth');
const { calculateFare } = require('../lib/pricing');

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

function buildUserSummary(user) {
  if (!user) return null;

  return {
    _id: user._id,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

function toPlainRide(ride) {
  return ride && typeof ride.toObject === 'function' ? ride.toObject() : ride;
}

async function enrichRideWithUsers(ride) {
  const plainRide = toPlainRide(ride);
  if (!plainRide) return null;

  const riderId = plainRide.rider ? String(plainRide.rider) : null;
  const driverId = plainRide.acceptedBy ? String(plainRide.acceptedBy) : null;
  const userIds = [...new Set([riderId, driverId].filter(Boolean))];

  const users = userIds.length > 0
    ? await User.find({ _id: { $in: userIds } }, { name: 1, avatarUrl: 1 }).lean()
    : [];
  const userMap = Object.fromEntries(users.map((user) => [String(user._id), user]));

  const riderUser = riderId ? userMap[riderId] : null;
  const driverUser = driverId ? userMap[driverId] : null;

  return {
    ...plainRide,
    riderName: riderUser?.name || plainRide.riderName || 'Rider',
    riderAvatarUrl: riderUser?.avatarUrl || plainRide.riderAvatarUrl || null,
    driverName: driverUser?.name || plainRide.driverName || null,
    driverAvatarUrl: driverUser?.avatarUrl || plainRide.driverAvatarUrl || null,
    rider: riderUser ? buildUserSummary(riderUser) : plainRide.rider,
    driver: driverUser ? buildUserSummary(driverUser) : plainRide.driver || null,
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

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function resolveTaxAmount(subTotal) {
  return roundMoney(Math.max(0, Number(subTotal) || 0) * 0.05);
}

function buildPaymentSummary({ ride, vehicleId, countryCode, region, distanceKm, durationMin }) {
  const fare = calculateFare({
    vehicleId: vehicleId || ride.selectedVehicle || 'car',
    distanceKm: Number(distanceKm) || Number(ride.distanceKm) || 0,
    durationMin: Number(durationMin) || Math.max(1, Math.round((Number(distanceKm) || Number(ride.distanceKm) || 0) * 3)),
    countryCode: countryCode || ride.countryCode,
    region: region || ride.region,
    surge: ride.surge || 'normal',
  });

  const taxAmount = resolveTaxAmount(fare.fare);
  const totalFare = roundMoney(fare.fare + taxAmount);

  return {
    currency: fare.currency || ride.currency || 'USD',
    region: fare.region || ride.region || null,
    countryCode: fare.countryCode || ride.countryCode || null,
    baseFare: roundMoney(fare.breakdown.baseFare),
    distanceFare: roundMoney(fare.breakdown.distanceFare),
    timeFare: roundMoney(fare.breakdown.timeFare),
    taxAmount,
    totalFare,
  };
}

function buildRecentRideEntry(ride, options = {}) {
  const pickupAddress = ride?.pickup?.address || 'Pickup location';
  const destinationAddress = ride?.destination?.address || ride?.destination?.name || 'Destination';

  return {
    _id: String(ride._id),
    title: options.title || destinationAddress,
    address: options.address || destinationAddress,
    detail: options.detail || pickupAddress,
    pickupAddress,
    destinationAddress,
    selectedVehicle: ride.selectedVehicle || 'car',
    finalFare: typeof ride.finalFare === 'number' ? ride.finalFare : null,
    completedAt: ride.completedAt || ride.updatedAt || ride.requestedAt || null,
  };
}

async function updateUserRating(userId, score) {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore) || numericScore < 1 || numericScore > 5) {
    return null;
  }

  const user = await User.findById(userId);
  if (!user) {
    return null;
  }

  user.ratingCount = Number(user.ratingCount) || 0;
  user.ratingTotal = Number(user.ratingTotal) || 0;
  user.ratingCount += 1;
  user.ratingTotal += numericScore;
  user.rating = Number((user.ratingTotal / user.ratingCount).toFixed(1));
  await user.save();
  return user;
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
      countryCode,
      region,
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
      countryCode: countryCode || null,
      region: region || null,
      currency: 'USD',
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
      estimatedFare: Number.isFinite(Number(distanceKm))
        ? buildPaymentSummary({
            ride: { selectedVehicle: selectedVehicle || 'car', distanceKm, countryCode, region },
            vehicleId: selectedVehicle || 'car',
            countryCode,
            region,
            distanceKm,
            durationMin: Math.max(1, Math.round(Number(distanceKm) * 3)),
          }).totalFare
        : undefined,
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

    const rides = await Promise.all(upcomingRides.map((ride) => enrichRideWithUsers(ride)));

    return res.status(200).json({
      rides,
      count: rides.length,
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
      rejectedByDrivers: { $nin: [driver._id] },
    })
      .sort({ requestedAt: -1, createdAt: -1 })
      .lean();

    const availableRides = rides
      .map((ride) => {
        const pickup = parseRidePoint(ride.pickup);
        const pickupDistanceKm = hasDriverLocation && pickup
          ? Number(haversineKm(driverLat, driverLon, pickup.latitude, pickup.longitude).toFixed(2))
          : null;
        const rideDistanceKm = Number(ride.distanceKm);
        return {
          ...ride,
          // Keep the rider trip distance for display while still exposing driver->pickup proximity.
          distanceKm: Number.isFinite(rideDistanceKm) ? Number(rideDistanceKm.toFixed(2)) : pickupDistanceKm,
          pickupDistanceKm,
        };
      })
      .filter((ride) => ride.pickupDistanceKm == null || ride.pickupDistanceKm <= radiusKm)
      .slice(0, 10);

    // Bulk-lookup rider User documents so drivers always see fresh profile pictures.
    const riderIds = [...new Set(availableRides.map((r) => String(r.rider)).filter(Boolean))];
    const riderDocs = riderIds.length > 0
      ? await User.find({ _id: { $in: riderIds } }, { avatarUrl: 1, name: 1 }).lean()
      : [];
    const riderMap = Object.fromEntries(riderDocs.map((u) => [String(u._id), u]));

    const ridesWithAvatars = availableRides.map((ride) => {
      const riderDoc = riderMap[String(ride.rider)];
      return {
        ...ride,
        riderAvatarUrl: riderDoc?.avatarUrl || ride.riderAvatarUrl || null,
        riderName: riderDoc?.name || ride.riderName || 'Rider',
      };
    });

    return res.status(200).json({
      rides: ridesWithAvatars,
      count: ridesWithAvatars.length,
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

    const riderUser = await User.findById(ride.rider).lean();

    return res.status(200).json({
      ride: {
        ...ride,
        // Expose fresh avatar + name at the top level so the driver app can read
        // riderAvatarUrl / riderName directly without drilling into the nested rider object.
        riderAvatarUrl: riderUser?.avatarUrl || ride.riderAvatarUrl || null,
        riderName: riderUser?.name || ride.riderName || 'Rider',
        rider: riderUser
          ? {
              _id: riderUser._id,
              name: riderUser.name,
              avatarUrl: riderUser.avatarUrl,
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

    return res.status(200).json({ ride: await enrichRideWithUsers(ride) });
  } catch (err) {
    console.error('Rider current ride error:', err);
    return res.status(500).json({ error: 'Failed to load ride status' });
  }
});

router.get('/rider/recent', async (req, res) => {
  try {
    const rider = await getAuthenticatedUser(req, res);
    if (!rider) return;

    if (rider.role !== 'rider') {
      return res.status(403).json({ error: 'Only riders can view recent rides' });
    }

    const rides = await ScheduledRide.find({
      rider: rider._id,
      status: 'completed',
    })
      .sort({ completedAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(5)
      .lean();

    return res.status(200).json({
      recents: rides.map((ride) => buildRecentRideEntry(ride, {
        title: ride.destination?.name || ride.destination?.address || 'Recent destination',
        address: ride.destination?.address || ride.destination?.name || 'Recent destination',
        detail: ride.pickup?.address || 'Pickup location',
      })),
      count: rides.length,
    });
  } catch (err) {
    console.error('Rider recent rides error:', err);
    return res.status(500).json({ error: 'Failed to load recent rides' });
  }
});

router.get('/driver/recent', async (req, res) => {
  try {
    const driver = await getAuthenticatedUser(req, res);
    if (!driver) return;

    if (driver.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can view recent rides' });
    }

    const rides = await ScheduledRide.find({
      acceptedBy: driver._id,
      status: 'completed',
    })
      .sort({ completedAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(5)
      .lean();

    return res.status(200).json({
      recents: rides.map((ride) => buildRecentRideEntry(ride, {
        title: ride.destination?.name || ride.destination?.address || 'Recent destination',
        address: ride.destination?.address || ride.destination?.name || 'Recent destination',
        detail: ride.pickup?.address || 'Pickup location',
      })),
      count: rides.length,
    });
  } catch (err) {
    console.error('Driver recent rides error:', err);
    return res.status(500).json({ error: 'Failed to load recent rides' });
  }
});

router.get('/:rideId', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const isRider = String(ride.rider) === String(user._id);
    const isDriver = String(ride.acceptedBy || '') === String(user._id);
    if (!isRider && !isDriver) {
      return res.status(403).json({ error: 'You are not allowed to view this ride' });
    }

    return res.status(200).json({ ride: await enrichRideWithUsers(ride) });
  } catch (err) {
    console.error('Ride fetch error:', err);
    return res.status(500).json({ error: 'Failed to load ride' });
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

    return res.status(200).json({ ride: await enrichRideWithUsers(ride) });
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
    ride.driverName = driver.name;
    ride.acceptedAt = new Date();
    await ride.save();

    return res.status(200).json({ ride: await enrichRideWithUsers(ride) });
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
    return res.status(200).json({ ride: await enrichRideWithUsers(ride) });
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

    return res.status(200).json({ ride: await enrichRideWithUsers(ride) });
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

    const completedAt = new Date();
    const startedAt = ride.startedAt ? new Date(ride.startedAt) : completedAt;
    const actualDurationMin = Math.max(1, Math.round((completedAt.getTime() - startedAt.getTime()) / 60000));
    const payment = buildPaymentSummary({
      ride,
      vehicleId: ride.selectedVehicle || driver.vehicleType || 'car',
      countryCode: ride.countryCode,
      region: ride.region,
      distanceKm: ride.distanceKm,
      durationMin: actualDurationMin,
    });

    ride.status = 'completed';
    ride.completedAt = completedAt;
    ride.finalFare = payment.totalFare;
    ride.taxAmount = payment.taxAmount;
    ride.currency = payment.currency;
    ride.countryCode = payment.countryCode;
    ride.region = payment.region;
    ride.fareBreakdown = {
      baseFare: payment.baseFare,
      distanceFare: payment.distanceFare,
      timeFare: payment.timeFare,
      taxAmount: payment.taxAmount,
      totalFare: payment.totalFare,
    };
    await ride.save();

    return res.status(200).json({
      ride: ride.toObject(),
      receipt: {
        rideId: ride._id,
        currency: payment.currency,
        amount: payment.totalFare,
        taxAmount: payment.taxAmount,
        fareBreakdown: ride.fareBreakdown,
      },
    });
  } catch (err) {
    console.error('Ride complete error:', err);
    return res.status(500).json({ error: 'Failed to complete ride' });
  }
});

router.post('/:rideId/rating', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const { rating, targetRole, comment } = req.body || {};
    const numericRating = Number(rating);
    if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' });
    }

    const role = (targetRole || '').toString().toLowerCase();
    let targetUserId = null;

    if (role === 'driver' && String(ride.rider) === String(user._id)) {
      targetUserId = ride.acceptedBy;
      ride.driverRating = numericRating;
      ride.driverRatedAt = new Date();
    } else if (role === 'rider' && String(ride.acceptedBy || '') === String(user._id)) {
      targetUserId = ride.rider;
      ride.riderRating = numericRating;
      ride.riderRatedAt = new Date();
    } else {
      return res.status(403).json({ error: 'You are not allowed to rate this user' });
    }

    if (comment) {
      ride.ratingComment = comment.toString().trim().slice(0, 500);
    }

    await ride.save();
    const targetUser = targetUserId ? await updateUserRating(targetUserId, numericRating) : null;

    return res.status(200).json({
      ride: ride.toObject(),
      targetUser: targetUser
        ? {
            _id: targetUser._id,
            rating: targetUser.rating,
            ratingCount: targetUser.ratingCount,
          }
        : null,
    });
  } catch (err) {
    console.error('Ride rating error:', err);
    return res.status(500).json({ error: 'Failed to save rating' });
  }
});

router.post('/:rideId/issues', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const { category, details } = req.body || {};
    const issue = {
      reportedBy: user._id,
      category: (category || 'general').toString().trim().slice(0, 80),
      details: (details || '').toString().trim().slice(0, 1000),
      createdAt: new Date(),
    };

    if (!Array.isArray(ride.reportIssues)) {
      ride.reportIssues = [];
    }

    ride.reportIssues.push(issue);
    await ride.save();

    return res.status(200).json({ ride: ride.toObject(), issue });
  } catch (err) {
    console.error('Ride issue report error:', err);
    return res.status(500).json({ error: 'Failed to report issue' });
  }
});

router.get('/:rideId/receipt', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const ride = await findRideById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const isOwner = String(ride.rider) === String(user._id) || String(ride.acceptedBy || '') === String(user._id);
    if (!isOwner) {
      return res.status(403).json({ error: 'You are not allowed to view this receipt' });
    }

    let driverName = ride.driverName || ride.driver?.name || null;
    if (!driverName && ride.acceptedBy) {
      const driver = await User.findById(ride.acceptedBy).lean();
      driverName = driver?.name || null;
    }

    return res.status(200).json({
      receipt: {
        rideId: ride._id,
        riderName: ride.riderName,
        driverName,
        pickup: ride.pickup,
        destination: ride.destination,
        selectedVehicle: ride.selectedVehicle,
        currency: ride.currency || 'USD',
        estimatedFare: ride.estimatedFare || null,
        finalFare: ride.finalFare || null,
        taxAmount: ride.taxAmount || null,
        fareBreakdown: ride.fareBreakdown || null,
        completedAt: ride.completedAt || null,
        startedAt: ride.startedAt || null,
        requestedAt: ride.requestedAt || null,
        status: ride.status,
      },
    });
  } catch (err) {
    console.error('Ride receipt error:', err);
    return res.status(500).json({ error: 'Failed to load receipt' });
  }
});

module.exports = router;