const mongoose = require('mongoose');

const ScheduledRideSchema = new mongoose.Schema({
  rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  riderName: { type: String, required: true },
  riderAvatarUrl: { type: String },
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
  scheduledAt: { type: Date, required: true, index: true },
  distanceKm: { type: Number },
  status: {
    type: String,
    enum: ['scheduled', 'offered', 'accepted', 'completed', 'cancelled'],
    default: 'scheduled',
    index: true,
  },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acceptedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ScheduledRideSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('ScheduledRide', ScheduledRideSchema);