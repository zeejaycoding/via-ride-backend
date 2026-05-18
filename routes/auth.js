const express = require('express');
const bcrypt = require('bcrypt');
const twilio = require('twilio');
const router = express.Router();
const User = require('../models/User');
const Verification = require('../models/Verification');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return null;
  }

  return twilio(accountSid, authToken);
}

const ALLOWED_ROLES = new Set(['driver', 'rider']);

function normalizeRole(role) {
  return (role || '').toString().trim().toLowerCase();
}

function isAllowedRole(role) {
  return ALLOWED_ROLES.has(normalizeRole(role));
}

// Helper: normalize phone to E.164 format using the country code selected on the frontend.
function normalizePhone(phone, countryCode) {
  if (!phone) return null;

  const digits = phone.replace(/[^0-9]/g, '');
  if (!digits) return null;

  const rawCountryCode = (countryCode || '').toString().trim();
  const normalizedCountryCode = rawCountryCode
    ? rawCountryCode.startsWith('+')
      ? rawCountryCode
      : `+${rawCountryCode.replace(/[^0-9]/g, '')}`
    : '';

  if (phone.trim().startsWith('+')) {
    return `+${phone.replace(/[^0-9]/g, '')}`;
  }

  if (normalizedCountryCode) {
    return `${normalizedCountryCode}${digits.replace(/^0+/, '')}`;
  }

  return `+${digits}`;
}

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `avatar-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
      return;
    }

    cb(new Error('Only image files are allowed'));
  },
});

async function getAuthenticatedUser(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return null;
  }

  const JWT_SECRET = process.env.JWT_SECRET || process.env.CLERK_SECRET_KEY || 'please_change_this_secret';
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (_err) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }

  return user;
}

// POST /api/auth/signup
// Creates a pending user and sends verification code via Twilio Verify
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, countryCode, gender, role, password } = req.body;
    const requestedRole = normalizeRole(role);

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!email && !phone) return res.status(400).json({ error: 'Email or phone is required' });
    if (!isAllowedRole(requestedRole)) {
      return res.status(400).json({ error: 'Valid role is required (driver or rider)' });
    }

    // Check existing user
    const existing = await User.findOne({ $or: [{ email }, { phone }] });
    if (existing) return res.status(409).json({ error: 'User already exists' });

    let passwordHash;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    const normalizedPhone = normalizePhone(phone, countryCode);

    // Create user in pending state
    const user = new User({
      name,
      email,
      phone: normalizedPhone,
      gender,
      role: requestedRole,
      passwordHash,
      verified: false,
    });
    await user.save();

    // Send verification via Twilio Verify if phone and VERIFY_SID exist
    let verificationSid = null;
    if (normalizedPhone && process.env.TWILIO_VERIFY_SID) {
      try {
        console.log('Sending OTP to', normalizedPhone);
        const twilioClient = getTwilioClient();
        if (!twilioClient) {
          throw new Error('Twilio Verify is not configured');
        }

        const verification = await twilioClient.verify.v2
          .services(process.env.TWILIO_VERIFY_SID)
          .verifications.create({ to: normalizedPhone, channel: 'sms' });
        verificationSid = verification.sid;
      } catch (err) {
        console.error('Twilio Verify error:', err.message);
        // Don't fail signup if Verify fails
      }
    }

    // Store verification record
    const verificationDoc = new Verification({
      userId: user._id,
      phone: normalizedPhone,
      email,
      verifySid: verificationSid,
    });
    await verificationDoc.save();

    return res.status(201).json({
      user: {
        _id: user._id,
        name,
        phone,
        email,
        role: requestedRole,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/verify
// Verifies code via Twilio Verify and marks user as verified
router.post('/verify', async (req, res) => {
  try {
    const { userId, code, expectedRole } = req.body;
    const normalizedExpectedRole = expectedRole ? normalizeRole(expectedRole) : '';

    if (!userId || !code) {
      return res.status(400).json({ error: 'userId and code are required' });
    }
    if (expectedRole && !isAllowedRole(normalizedExpectedRole)) {
      return res.status(400).json({ error: 'expectedRole must be driver or rider' });
    }

    // Get user and verification record
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (normalizedExpectedRole && normalizeRole(user.role) !== normalizedExpectedRole) {
      return res.status(403).json({ error: 'This account is not allowed in this app' });
    }

    const verification = await Verification.findOne({ userId });
    if (!verification) {
      return res.status(400).json({ error: 'No verification request found' });
    }

    // Check code via Twilio Verify if verifySid exists
    if (verification.verifySid && process.env.TWILIO_VERIFY_SID) {
      try {
        const normalized = normalizePhone(user.phone);
        const twilioClient = getTwilioClient();
        if (!twilioClient) {
          return res.status(400).json({ error: 'Twilio Verify is not configured' });
        }

        const result = await twilioClient.verify.v2
          .services(process.env.TWILIO_VERIFY_SID)
          .verificationChecks.create({ to: normalized, code });

        if (result.status !== 'approved') {
          return res.status(400).json({ error: 'Invalid verification code' });
        }
      } catch (err) {
        console.error('Twilio Verify check error:', err.message);
        return res.status(400).json({ error: 'Invalid or expired code' });
      }
    }

    // Mark user as verified
    const updatedUser = await User.findByIdAndUpdate(userId, { verified: true }, { new: true });

    // Delete verification record
    await Verification.deleteOne({ _id: verification._id });

    const JWT_SECRET = process.env.JWT_SECRET || process.env.CLERK_SECRET_KEY || 'please_change_this_secret';
    const token = jwt.sign({ id: updatedUser._id, role: updatedUser.role || 'rider' }, JWT_SECRET, { expiresIn: '30d' });

    const userObj = updatedUser.toObject();
    delete userObj.passwordHash;

    return res.status(200).json({ token, user: userObj });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/resend
// Resends verification code via Twilio Verify
router.post('/resend', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Delete old verification record
    await Verification.deleteOne({ userId });

    // Resend via Twilio Verify if phone and VERIFY_SID exist
    let verificationSid = null;
    if (user.phone && process.env.TWILIO_VERIFY_SID) {
      try {
        const normalized = normalizePhone(user.phone);
        console.log('Resending OTP to', normalized);
        const twilioClient = getTwilioClient();
        if (!twilioClient) {
          throw new Error('Twilio Verify is not configured');
        }

        const verification = await twilioClient.verify.v2
          .services(process.env.TWILIO_VERIFY_SID)
          .verifications.create({ to: normalized, channel: 'sms' });
        verificationSid = verification.sid;
      } catch (err) {
        console.error('Twilio Verify error:', err.message);
      }
    }

    // Create new verification record
    const verificationDoc = new Verification({
      userId: user._id,
      phone: user.phone,
      email: user.email,
      verifySid: verificationSid,
    });
    await verificationDoc.save();

    return res.status(200).json({ message: 'Code resent' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/clerk
// Accepts `{ clerkSessionId, clerkUserId }` from the frontend (returned by Clerk after social sign-in)
// Verifies the Clerk session/user using Clerk's REST API, creates or finds a local `User`, and
// returns a backend JWT for the app to use.
router.post('/clerk', async (req, res) => {
  try {
    const { clerkSessionId, clerkUserId, expectedRole } = req.body;
    const normalizedExpectedRole = normalizeRole(expectedRole);

    if (!clerkSessionId && !clerkUserId) {
      return res.status(400).json({ error: 'clerkSessionId or clerkUserId required' });
    }
    if (!isAllowedRole(normalizedExpectedRole)) {
      return res.status(400).json({ error: 'expectedRole must be driver or rider' });
    }

    const CLERK_API_KEY = process.env.CLERK_SECRET_KEY;
    if (!CLERK_API_KEY) return res.status(500).json({ error: 'Clerk API key not configured' });

    let userId = clerkUserId;

    if (clerkSessionId) {
      // verify session
      const sessionResp = await axios.get(
        `https://api.clerk.com/v1/sessions/${encodeURIComponent(clerkSessionId)}`,
        { headers: { Authorization: `Bearer ${CLERK_API_KEY}` } }
      );
      const session = sessionResp.data;
      if (!session || session.status !== 'active') return res.status(401).json({ error: 'Invalid Clerk session' });
      userId = session.user_id;
    }

    // fetch Clerk user
    const userResp = await axios.get(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${CLERK_API_KEY}` },
    });
    const clerkUser = userResp.data;

    // extract email and name
    const email = (clerkUser.email_addresses && clerkUser.email_addresses[0] && clerkUser.email_addresses[0].email_address) || clerkUser.email || null;
    const name = [clerkUser.first_name, clerkUser.last_name].filter(Boolean).join(' ') || clerkUser.full_name || clerkUser.username || 'Unknown';

    // find or create local user
    let user = null;
    if (email) user = await User.findOne({ email });
    if (!user) {
      user = new User({ name, email, role: normalizedExpectedRole, verified: true });
      await user.save();
    } else if (normalizeRole(user.role) !== normalizedExpectedRole) {
      return res.status(403).json({ error: 'This account is not allowed in this app' });
    }

    // sign backend JWT
    const JWT_SECRET = process.env.JWT_SECRET || process.env.CLERK_SECRET_KEY || 'please_change_this_secret';
    const token = jwt.sign({ id: user._id, role: user.role || 'rider' }, JWT_SECRET, { expiresIn: '30d' });

    const userObj = user.toObject();
    delete userObj.passwordHash;

    return res.status(200).json({ token, user: userObj });
  } catch (err) {
    console.error('Clerk signin error:', err?.response?.data || err.message || err);
    return res.status(500).json({ error: 'Clerk signin failed' });
  }
});

// POST /api/auth/login
// Normal email + password signin that returns backend JWT
router.post('/login', async (req, res) => {
  try {
    const { email, phone, identifier, password, expectedRole } = req.body;
    const normalizedExpectedRole = normalizeRole(expectedRole);
    const loginIdentifier = (identifier || email || phone || '').toString().trim();
    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: 'identifier and password required' });
    }
    if (!isAllowedRole(normalizedExpectedRole)) {
      return res.status(400).json({ error: 'expectedRole must be driver or rider' });
    }

    const lookup = loginIdentifier.includes('@')
      ? { email: loginIdentifier.toLowerCase() }
      : { $or: [{ phone: normalizePhone(loginIdentifier) }, { phone: loginIdentifier }] };

    const user = await User.findOne(lookup);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (normalizeRole(user.role) !== normalizedExpectedRole) {
      return res.status(403).json({ error: 'This account is not allowed in this app' });
    }
    if (!user.passwordHash) return res.status(400).json({ error: 'No password set for this user' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    if (!user.verified) {
      // optional: allow login anyway, but here we require verification
      return res.status(403).json({ error: 'User not verified' });
    }

    const JWT_SECRET = process.env.JWT_SECRET || process.env.CLERK_SECRET_KEY || 'please_change_this_secret';
    const token = jwt.sign({ id: user._id, role: user.role || 'rider' }, JWT_SECRET, { expiresIn: '30d' });

    const userObj = user.toObject();
    delete userObj.passwordHash;

    return res.status(200).json({ token, user: userObj });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/profile
// Returns the logged-in user's profile
router.get('/profile', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const userObj = user.toObject();
    delete userObj.passwordHash;

    return res.status(200).json(userObj);
  } catch (err) {
    console.error('Profile error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/auth/profile/avatar
// Uploads and saves authenticated user's profile photo
router.patch('/profile/avatar', (req, res) => {
  upload.single('avatar')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        return res.status(400).json({ error: uploadErr.message || 'Avatar upload failed' });
      }

      const user = await getAuthenticatedUser(req, res);
      if (!user) return;

      if (!req.file) {
        return res.status(400).json({ error: 'Avatar file is required' });
      }

      const relativePath = `/uploads/${req.file.filename}`;
      const avatarUrl = `${req.protocol}://${req.get('host')}${relativePath}`;

      user.avatarUrl = avatarUrl;
      await user.save();

      const userObj = user.toObject();
      delete userObj.passwordHash;

      return res.status(200).json(userObj);
    } catch (err) {
      console.error('Avatar upload error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  });
});

module.exports = router;
module.exports.getAuthenticatedUser = getAuthenticatedUser;
