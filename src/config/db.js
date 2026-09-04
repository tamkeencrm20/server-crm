import mongoose from 'mongoose';
import env from './env.js';
import logger from '../utils/logger.js';

mongoose.set('strictQuery', true);

export async function connectDatabase() {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => logger.error('MongoDB error', err));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  await mongoose.connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: !env.isProd, // in production indexes are created by a deliberate migration
  });

  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.connection.close();
}
