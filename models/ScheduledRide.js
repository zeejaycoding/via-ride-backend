const mongoose = require('mongoose');

const ScheduledRideSchema = new mongoose.Schema({
  rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  riderName: { type: String, required: true },
  riderAvatarUrl: { type: String },
  rideKind: { type: String, enum: ['now', 'schedule'], default: 'now' },
  selectedVehicle: { type: String, default: 'car' },
  pickup: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    address: { type: String, required: true },
  },
  destination: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
  },
  rideType: { type: String, default: 'schedule' },
  scheduledAt: { type: Date, required: true, index: true, default: Date.now },
  distanceKm: { type: Number },
  countryCode: { type: String },
  region: { type: String },
  currency: { type: String, default: 'USD' },
  estimatedFare: { type: Number },
  finalFare: { type: Number },
  taxAmount: { type: Number },
  fareBreakdown: {
    baseFare: { type: Number },
    distanceFare: { type: Number },
    timeFare: { type: Number },
    taxAmount: { type: Number },
    totalFare: { type: Number },
  },
  status: {
    type: String,
    enum: ['requested', 'scheduled', 'offered', 'accepted', 'in_progress', 'completed', 'cancelled', 'rejected'],
    default: 'requested',
    index: true,
  },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acceptedAt: { type: Date },
  rejectedByDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  requestedAt: { type: Date, default: Date.now },
  startedAt: { type: Date },
  completedAt: { type: Date },
  cancelledAt: { type: Date },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  riderRating: { type: Number },
  riderRatedAt: { type: Date },
  driverRating: { type: Number },
  driverRatedAt: { type: Date },
  reportIssues: [{
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    category: { type: String },
    details: { type: String },
    createdAt: { type: Date, default: Date.now },
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ScheduledRideSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('ScheduledRide', ScheduledRideSchema);