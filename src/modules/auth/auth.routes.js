import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as authService from './auth.service.js';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/errors.js';

const router = Router();

// Credential stuffing guard. Deliberately generous enough that a whole branch
// behind one office IP is not locked out by normal morning sign-ins.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts, try again later' } },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

const context = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body.email, req.body.password, context(req));
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/refresh',
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken, context(req));
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await authService.logout(req.body?.refreshToken);
    res.json({ success: true, data: { message: 'Signed out' } });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: req.user.toJSON() });
  }),
);

router.post(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.changePassword(req.user, req.body.currentPassword, req.body.newPassword);
    res.json({ success: true, data: { message: 'Password changed, please sign in again' } });
  }),
);

export default router;
