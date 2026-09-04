import mongoose from 'mongoose';
import env from '../config/env.js';
import logger from '../utils/logger.js';
import { AppError, notFound } from '../utils/errors.js';

export function notFoundHandler(req, _res, next) {
  next(notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid value for ${err.path}`;
  } else if (err?.code === 11000) {
    status = 409;
    code = 'DUPLICATE_KEY';
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    message = `A record with this ${field} already exists`;
  }

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} ->`, err);
  } else {
    logger.debug(`${req.method} ${req.originalUrl} -> ${status} ${code}: ${message}`);
  }

  res.status(status).json({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    ...(env.isProd || status < 500 ? {} : { stack: err.stack }),
  });
}
