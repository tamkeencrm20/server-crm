import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import User from '../models/User.js';

let io = null;

/** Room naming — keep every emit going through these helpers. */
export const room = {
  user: (id) => `user:${id}`,
  branch: (id) => `branch:${id}`,
  admins: () => 'role:admin',
};

/**
 * Attaches Socket.io to the HTTP server. Clients authenticate with the same
 * access token they use for REST, passed as `auth.token`, and are then joined
 * to their personal room plus their branch room.
 */
export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('UNAUTHORIZED'));

      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
      const user = await User.findById(payload.sub).select('name role branch isActive').lean();
      if (!user || !user.isActive) return next(new Error('UNAUTHORIZED'));

      socket.data.user = user;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(room.user(user._id));
    if (user.branch) socket.join(room.branch(user.branch));
    if (user.role === 'admin') socket.join(room.admins());

    logger.debug(`socket connected: ${user.name} (${user.role})`);
    socket.on('disconnect', () => logger.debug(`socket disconnected: ${user.name}`));
  });

  return io;
}

/**
 * Emit to one or more rooms. Safe to call before init (during seeding or
 * tests) — it simply does nothing.
 */
export function emitTo(rooms, event, payload) {
  if (!io) return;
  const targets = Array.isArray(rooms) ? rooms : [rooms];
  if (targets.length === 0) return;
  io.to(targets).emit(event, payload);
}

export function getIO() {
  return io;
}
