const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, index: true, sparse: true },
  phone: { type: String, index: true, sparse: true },
  avatarUrl: { type: String },
  gender: { type: String },
  role: { type: String, enum: ['driver', 'rider'], default: 'rider' },
  driverStatus: { type: String, enum: ['pending', 'approved', 'rejected', 'offline', 'online'], default: 'offline' },
  isOnline: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: false },
  currentLocation: {
    latitude: { type: Number },
    longitude: { type: Number },
    updatedAt: { type: Date },
  },
  vehicleType: { type: String },
  vehicleName: { type: String },
  plateNumber: { type: String },
  rating: { type: Number, default: 4.8 },
  passwordHash: { type: String },
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', UserSchema);
