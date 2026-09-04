import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import env from './config/env.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/users.routes.js';
import branchRoutes from './modules/branches/branches.routes.js';
import courseRoutes from './modules/courses/courses.routes.js';
import leadRoutes from './modules/leads/leads.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import metaRoutes from './modules/meta/meta.routes.js';

export function createApp() {
  const app = express();

  // Behind nginx / a load balancer, so req.ip is the real client.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(compression());
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin and server-to-server calls arrive without an Origin.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
    }),
  );

  // The Meta webhook signature is computed over the exact bytes sent, so the
  // raw body has to survive JSON parsing.
  app.use(
    express.json({
      limit: '1mb',
      verify(req, _res, buf) {
        if (req.originalUrl.startsWith('/api/meta/webhook')) req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  if (!env.isProd) app.use(morgan('dev'));

  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      // Meta delivers bursts; the HMAC signature is the real gate there.
      skip: (req) => req.path.startsWith('/meta/webhook'),
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        service: 'tamkeen-crm-api',
        status: 'ok',
        env: env.NODE_ENV,
        metaConfigured: env.metaConfigured,
        time: new Date().toISOString(),
      },
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/branches', branchRoutes);
  app.use('/api/courses', courseRoutes);
  app.use('/api/leads', leadRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/meta', metaRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
