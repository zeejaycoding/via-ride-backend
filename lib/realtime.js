let io = null;

function initRealtime(serverIo) {
  io = serverIo;
  return io;
}

function getRealtime() {
  return io;
}

function roomForRide(rideId) {
  return rideId ? `ride:${rideId}` : null;
}

function emitRideEvent(rideId, eventName, payload) {
  if (!io || !rideId) return;
  io.to(roomForRide(rideId)).emit(eventName, payload);
}

function emitUserEvent(userId, eventName, payload) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(eventName, payload);
}

module.exports = {
  initRealtime,
  getRealtime,
  roomForRide,
  emitRideEvent,
  emitUserEvent,
};