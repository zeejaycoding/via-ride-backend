const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { initRealtime } = require('./lib/realtime');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const ScheduledRide = require('./models/ScheduledRide');
const ChatMessage = require('./models/ChatMessage');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  },
});

initRealtime(io);

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.CLERK_SECRET_KEY || 'please_change_this_secret';
}

function isRideParticipant(ride, userId) {
  if (!ride || !userId) return false;
  return String(ride.rider) === String(userId) || String(ride.acceptedBy || '') === String(userId);
}

function buildSocketChatPayload(message, sender) {
  return {
    _id: String(message._id),
    rideId: String(message.rideId),
    sender: String(message.sender),
    senderRole: message.senderRole,
    text: message.text,
    createdAt: message.createdAt,
    senderName: sender?.name || null,
    senderAvatarUrl: sender?.avatarUrl || null,
  };
}

io.use(async (socket, next) => {
  try {
    const authHeader = socket.handshake.auth?.token || socket.handshake.headers?.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    if (!token) {
      return next(new Error('No token provided'));
    }

    const decoded = jwt.verify(token, getJwtSecret());
    const user = await User.findById(decoded.id).lean();
    if (!user) {
      return next(new Error('User not found'));
    }

    socket.data.user = user;
    return next();
  } catch (err) {
    return next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  socket.join(`user:${user._id}`);

  socket.on('ride:join', async (payload = {}, ack) => {
    try {
      const rideId = payload.rideId?.toString();
      if (!rideId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'rideId is required' });
        return;
      }

      const ride = await ScheduledRide.findById(rideId).lean();
      if (!ride || !isRideParticipant(ride, user._id)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Ride not accessible' });
        return;
      }

      socket.join(`ride:${rideId}`);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Failed to join ride room' });
    }
  });

  socket.on('chat:send', async (payload = {}, ack) => {
    try {
      const rideId = payload.rideId?.toString();
      const text = (payload.text || '').toString().trim();

      if (!rideId || !text) {
        if (typeof ack === 'function') ack({ ok: false, error: 'rideId and text are required' });
        return;
      }

      const ride = await ScheduledRide.findById(rideId).lean();
      if (!ride || !isRideParticipant(ride, user._id)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Ride not accessible' });
        return;
      }

      if (!ride.acceptedBy) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Chat is available after a driver accepts the ride' });
        return;
      }

      const senderRole = String(ride.rider) === String(user._id) ? 'rider' : 'driver';
      const message = await ChatMessage.create({
        rideId: ride._id,
        sender: user._id,
        senderRole,
        text,
      });

      const payloadOut = buildSocketChatPayload(message.toObject(), user);
      io.to(`ride:${rideId}`).emit('chat:message', payloadOut);

      if (typeof ack === 'function') ack({ ok: true, message: payloadOut });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Failed to send message' });
    }
  });
});

const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);
const placesRouter = require('./routes/places');
app.use('/api/places', placesRouter);
const tripRouter = require('./routes/trip');
app.use('/api/trip', tripRouter);
const driversRouter = require('./routes/drivers');
app.use('/api/drivers', driversRouter);
const scheduledRidesRouter = require('./routes/scheduled-rides');
app.use('/api/scheduled-rides', scheduledRidesRouter);
const communicationsRouter = require('./routes/communications');
app.use('/api/communications', communicationsRouter);

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || '';

async function start() {
  if (!MONGO_URI) {
    console.warn('MONGO_URI not set. Connect to MongoDB by adding MONGO_URI to .env');
  }

  try {
    if (MONGO_URI) await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
