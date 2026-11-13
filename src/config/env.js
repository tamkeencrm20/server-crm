import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // Comma-separated list of allowed browser origins.
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // Meta Lead Ads — optional until the Business account is wired up.
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v21.0'),

  // TikTok Lead Generation — optional until the Business account is wired up.
  TIKTOK_APP_SECRET: z.string().optional(),
  TIKTOK_VERIFY_TOKEN: z.string().optional(),
  TIKTOK_ACCESS_TOKEN: z.string().optional(),
  TIKTOK_API_VERSION: z.string().default('v1.3'),

  // Snapchat Lead Generation — optional until the Ads account is wired up.
  SNAPCHAT_APP_SECRET: z.string().optional(),
  SNAPCHAT_VERIFY_TOKEN: z.string().optional(),
  SNAPCHAT_ACCESS_TOKEN: z.string().optional(),
  SNAPCHAT_API_VERSION: z.string().default('v1'),

  // A lead arriving again within this window is treated as a duplicate.
  LEAD_DEDUPE_WINDOW_DAYS: z.coerce.number().int().nonnegative().default(30),
  // A "new" lead untouched for this long raises a stale alert.
  LEAD_STALE_HOURS: z.coerce.number().int().positive().default(4),

  ENABLE_CRON: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

const raw = parsed.data;

export const env = Object.freeze({
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isDev: raw.NODE_ENV === 'development',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  metaConfigured: Boolean(raw.META_APP_SECRET && raw.META_VERIFY_TOKEN),
  tiktokConfigured: Boolean(raw.TIKTOK_APP_SECRET && raw.TIKTOK_VERIFY_TOKEN),
  snapchatConfigured: Boolean(raw.SNAPCHAT_APP_SECRET && raw.SNAPCHAT_VERIFY_TOKEN),
});

export default env;
