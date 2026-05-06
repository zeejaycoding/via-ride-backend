const mongoose = require('mongoose');

const VerificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: { type: String },
  email: { type: String },
  verifySid: { type: String }, // Twilio Verify Service SID
  createdAt: { type: Date, default: Date.now, expires: 600 }, // auto-delete after 10 min
});

module.exports = mongoose.model('Verification', VerificationSchema);
