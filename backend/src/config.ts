import 'dotenv/config';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(env('PORT', '4000')),
  databaseUrl: env('DATABASE_URL'),
  publicAppUrl: env('PUBLIC_APP_URL', 'http://localhost:5173'),
  apiBaseUrl: env('API_BASE_URL', 'http://localhost:4000'),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()),
  jwtSecret: env('JWT_SECRET', isProd ? undefined : 'dev-insecure-jwt-secret-change-me'),
  accessTtlSec: Number(env('ACCESS_TOKEN_TTL_SEC', '900')),
  refreshTtlDays: Number(env('REFRESH_TOKEN_TTL_DAYS', '7')),
  /** 32-byte key (hex or base64) used to encrypt integration credentials at rest (INT-01) */
  encryptionKey: env('APP_ENCRYPTION_KEY', isProd ? undefined : '0'.repeat(64)),
  uploadDir: env('UPLOAD_DIR', './uploads'),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', '5')),
  /** Shared secret set on the Cloudflare Pages proxy; when it matches, X-Client-IP is the real client IP. */
  proxySecret: process.env.PROXY_SECRET || '',
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  jobsEnabled: env('JOBS_ENABLED', 'true') === 'true',
  chatwoot: {
    // Defaults; may be overridden from Settings → Integrations (stored encrypted in DB).
    baseUrl: process.env.CHATWOOT_BASE_URL || 'https://app.aiingo.com',
    accountId: process.env.CHATWOOT_ACCOUNT_ID || '',
    inboxId: process.env.CHATWOOT_INBOX_ID || '',
    apiToken: process.env.CHATWOOT_API_TOKEN || '',
    webhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET || '',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    from: process.env.MAIL_FROM || 'Nexora Academy <no-reply@nexoraedu.com>',
  },
};
