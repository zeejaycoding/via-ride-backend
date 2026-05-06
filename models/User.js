const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, index: true, sparse: true },
  phone: { type: String, index: true, sparse: true },
  avatarUrl: { type: String },
  gender: { type: String },
  role: { type: String, enum: ['driver', 'rider'], default: 'rider' },
  passwordHash: { type: String },
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', UserSchema);
