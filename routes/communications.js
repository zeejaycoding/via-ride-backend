const express = require('express');
const twilio = require('twilio');
const authRouter = require('./auth');
const ScheduledRide = require('../models/ScheduledRide');
const User = require('../models/User');
const ChatMessage = require('../models/ChatMessage');
const CallSession = require('../models/CallSession');
const { emitRideEvent } = require('../lib/realtime');

const router = express.Router();
const getAuthenticatedUser = authRouter.getAuthenticatedUser;

function normalizeText(value) {
  return (value || '').toString().trim();
}

function buildTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return null;
  }

  return twilio(accountSid, authToken);
}

function getPublicBaseUrl() {
  return (process.env.TWILIO_WEBHOOK_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.API_PUBLIC_BASE_URL || '').toString().replace(/\/$/, '');
}

function getTwilioPhoneNumber() {
  return (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_CALLER_ID || '').toString();
}

function rideRoomId(rideId) {
  return `ride:${rideId}`;
}

function isRideParticipant(ride, user) {
  if (!ride || !user) return false;
  return String(ride.rider) === String(user._id) || String(ride.acceptedBy || '') === String(user._id);
}

async function loadRideAndParticipant(rideId, user) {
  const ride = await ScheduledRide.findById(rideId).lean();
  if (!ride) {
    return { ride: null, error: 'Ride not found', statusCode: 404 };
  }

  if (!isRideParticipant(ride, user)) {
    return { ride: null, error: 'You are not allowed to access this ride', statusCode: 403 };
  }

  return { ride };
}

function buildChatPayload(message, sender) {
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

async function getRideParticipants(ride) {
  const riderId = String(ride.rider);
  const driverId = String(ride.acceptedBy || '');
  const userIds = [riderId, driverId].filter(Boolean);
  const users = userIds.length > 0
    ? await User.find({ _id: { $in: userIds } }, { name: 1, avatarUrl: 1, phone: 1 }).lean()
    : [];
  const userMap = Object.fromEntries(users.map((user) => [String(user._id), user]));

  return {
    rider: userMap[riderId] || null,
    driver: userMap[driverId] || null,
  };
}

async function getCallSessionForRide(rideId) {
  return CallSession.findOne({ rideId }).lean();
}

async function upsertCallSession(ride, initiatedBy, riderUser, driverUser) {
  const conferenceName = `ride-${ride._id}`;
  const baseSession = {
    rideId: ride._id,
    initiatedBy: initiatedBy._id,
    rider: riderUser._id,
    driver: driverUser._id,
    conferenceName,
    riderPhone: riderUser.phone || null,
    driverPhone: driverUser.phone || null,
  };

  const session = await CallSession.findOneAndUpdate(
    { rideId: ride._id },
    {
      $set: {
        ...baseSession,
        status: 'dialing',
        riderCallSid: null,
        driverCallSid: null,
        riderCallStatus: null,
        driverCallStatus: null,
        startedAt: null,
        endedAt: null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return session;
}

router.get('/chats/:rideId/messages', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const rideAccess = await loadRideAndParticipant(req.params.rideId, user);
    if (rideAccess.error) {
      return res.status(rideAccess.statusCode).json({ error: rideAccess.error });
    }

    const messages = await ChatMessage.find({ rideId: rideAccess.ride._id }).sort({ createdAt: 1 }).lean();
    const senderIds = [...new Set(messages.map((message) => String(message.sender)).filter(Boolean))];
    const senders = senderIds.length > 0
      ? await User.find({ _id: { $in: senderIds } }, { name: 1, avatarUrl: 1 }).lean()
      : [];
    const senderMap = Object.fromEntries(senders.map((sender) => [String(sender._id), sender]));

    return res.status(200).json({
      messages: messages.map((message) => buildChatPayload(message, senderMap[String(message.sender)])),
    });
  } catch (err) {
    console.error('Ride chat fetch error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to load chat messages' });
  }
});

router.post('/chats/:rideId/messages', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const rideAccess = await loadRideAndParticipant(req.params.rideId, user);
    if (rideAccess.error) {
      return res.status(rideAccess.statusCode).json({ error: rideAccess.error });
    }

    const ride = rideAccess.ride;
    if (!ride.acceptedBy) {
      return res.status(409).json({ error: 'Chat is available after a driver accepts the ride' });
    }

    const text = normalizeText(req.body?.text);
    if (!text) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const senderRole = String(ride.rider) === String(user._id) ? 'rider' : 'driver';
    const message = await ChatMessage.create({
      rideId: ride._id,
      sender: user._id,
      senderRole,
      text,
    });

    const payload = buildChatPayload(message.toObject(), user);
    emitRideEvent(ride._id, 'chat:message', payload);

    return res.status(201).json({ message: payload });
  } catch (err) {
    console.error('Ride chat send error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

router.get('/calls/:rideId', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const rideAccess = await loadRideAndParticipant(req.params.rideId, user);
    if (rideAccess.error) {
      return res.status(rideAccess.statusCode).json({ error: rideAccess.error });
    }

    const session = await getCallSessionForRide(rideAccess.ride._id);
    return res.status(200).json({ session });
  } catch (err) {
    console.error('Ride call fetch error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to load call session' });
  }
});

router.post('/calls/:rideId/request', async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const rideAccess = await loadRideAndParticipant(req.params.rideId, user);
    if (rideAccess.error) {
      return res.status(rideAccess.statusCode).json({ error: rideAccess.error });
    }

    const ride = rideAccess.ride;
    if (!ride.acceptedBy) {
      return res.status(409).json({ error: 'A driver must accept the ride before a call can start' });
    }

    const twilioClient = buildTwilioClient();
    const twilioNumber = getTwilioPhoneNumber();
    const publicBaseUrl = getPublicBaseUrl();

    if (!twilioClient || !twilioNumber || !publicBaseUrl) {
      return res.status(503).json({ error: 'Twilio calling is not configured' });
    }

    const participants = await getRideParticipants(ride);
    if (!participants.rider?.phone || !participants.driver?.phone) {
      return res.status(400).json({ error: 'Both rider and driver phone numbers are required for calling' });
    }

    const existingSession = await getCallSessionForRide(ride._id);
    if (existingSession && !['ended', 'failed'].includes((existingSession.status || '').toString())) {
      return res.status(200).json({ session: existingSession });
    }

    const session = await upsertCallSession(ride, user, participants.rider, participants.driver);

    const voiceUrlForRole = (role) => `${publicBaseUrl}/api/communications/twilio/voice?rideId=${encodeURIComponent(String(ride._id))}&role=${encodeURIComponent(role)}`;
    const statusUrlForRole = (role) => `${publicBaseUrl}/api/communications/twilio/status?rideId=${encodeURIComponent(String(ride._id))}&role=${encodeURIComponent(role)}`;

    const [driverCall, riderCall] = await Promise.all([
      twilioClient.calls.create({
        to: participants.driver.phone,
        from: twilioNumber,
        url: voiceUrlForRole('driver'),
        method: 'POST',
        statusCallback: statusUrlForRole('driver'),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      }),
      twilioClient.calls.create({
        to: participants.rider.phone,
        from: twilioNumber,
        url: voiceUrlForRole('rider'),
        method: 'POST',
        statusCallback: statusUrlForRole('rider'),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      }),
    ]);

    session.status = 'ringing';
    session.driverCallSid = driverCall.sid;
    session.riderCallSid = riderCall.sid;
    session.driverCallStatus = 'ringing';
    session.riderCallStatus = 'ringing';
    await session.save();

    emitRideEvent(ride._id, 'call:status', { session: session.toObject() });

    return res.status(200).json({ session: session.toObject() });
  } catch (err) {
    console.error('Ride call request error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to start call' });
  }
});

router.all('/twilio/voice', async (req, res) => {
  try {
    const rideId = req.query.rideId?.toString();
    const conferenceName = rideId ? `ride-${rideId}` : 'via-ride-call';
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial({ callerId: getTwilioPhoneNumber(), answerOnBridge: true });
    dial.conference({
      startConferenceOnEnter: true,
      endConferenceOnExit: false,
      waitUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
      beep: false,
    }, conferenceName);

    res.type('text/xml');
    return res.status(200).send(response.toString());
  } catch (err) {
    console.error('Twilio voice webhook error:', err?.message || err);
    return res.status(500).send('Unable to generate TwiML');
  }
});

router.post('/twilio/status', async (req, res) => {
  try {
    const rideId = req.query.rideId?.toString();
    const role = req.query.role?.toString();
    const callSid = normalizeText(req.body?.CallSid);
    const callStatus = normalizeText(req.body?.CallStatus).toLowerCase();

    if (!rideId || !role) {
      return res.status(400).json({ error: 'rideId and role are required' });
    }

    const session = await CallSession.findOne({ rideId });
    if (!session) {
      return res.status(200).json({ ok: true });
    }

    if (role === 'driver') {
      session.driverCallSid = session.driverCallSid || callSid || session.driverCallSid;
      session.driverCallStatus = callStatus || session.driverCallStatus;
    } else {
      session.riderCallSid = session.riderCallSid || callSid || session.riderCallSid;
      session.riderCallStatus = callStatus || session.riderCallStatus;
    }

    if (['ringing', 'in-progress'].includes(callStatus) && session.status !== 'connected') {
      session.status = callStatus === 'in-progress' ? 'connected' : 'ringing';
      if (callStatus === 'in-progress' && !session.startedAt) {
        session.startedAt = new Date();
      }
    }

    const driverDone = ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes((session.driverCallStatus || '').toLowerCase());
    const riderDone = ['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes((session.riderCallStatus || '').toLowerCase());
    if (driverDone && riderDone) {
      session.status = session.status === 'connected' ? 'ended' : session.status;
      session.endedAt = session.endedAt || new Date();
    }

    await session.save();
    emitRideEvent(rideId, 'call:status', { session: session.toObject() });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Twilio status callback error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to process call status' });
  }
});

module.exports = router;