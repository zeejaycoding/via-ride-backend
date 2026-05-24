const mongoose = require('mongoose');

const CallSessionSchema = new mongoose.Schema({
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScheduledRide', required: true, unique: true, index: true },
  initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: {
    type: String,
    enum: ['idle', 'dialing', 'ringing', 'connected', 'ended', 'failed'],
    default: 'idle',
    index: true,
  },
  conferenceName: { type: String, required: true },
  riderPhone: { type: String },
  driverPhone: { type: String },
  riderCallSid: { type: String },
  driverCallSid: { type: String },
  riderCallStatus: { type: String },
  driverCallStatus: { type: String },
  startedAt: { type: Date },
  endedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

CallSessionSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('CallSession', CallSessionSchema);