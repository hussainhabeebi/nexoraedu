const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Missing env ${k}`);
  return v;
};

const isProd = process.env.NODE_ENV === 'production';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';
const APP_ENVS: AppEnv[] = ['development', 'test', 'staging', 'production'];
/** Deployment environment. Defaults from NODE_ENV; staging must be set explicitly. */
export const appEnv: AppEnv = (() => {
  const v = process.env.APP_ENV as AppEnv | undefined;
  if (v && !APP_ENVS.includes(v)) throw new Error(`APP_ENV must be one of ${APP_ENVS.join(', ')}`);
  return v ?? (isProd ? 'production' : process.env.NODE_ENV === 'test' ? 'test' : 'development');
})();
/** Environments that hold or front real users: strict security guards apply. */
export const isHardened = appEnv === 'production' || appEnv === 'staging';

export const config = {
  isProd,
  appEnv,
  port: Number(env('PORT', '4000')),
  publicAppUrl: env('PUBLIC_APP_URL', 'http://localhost:5173'),
  apiBaseUrl: env('API_BASE_URL', 'http://localhost:4000'),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(',').map((s) => s.trim()),
  // Staging/production: no fallback. A missing secret is '' here and is reported by productionConfigProblems(),
  // so the Worker answers 503 (and runs no jobs) instead of crashing at start-up, which would also block the very
  // first deploy of a new Worker before its secrets can be added (deployment audit F1).
  jwtSecret: env('JWT_SECRET', isHardened || isProd ? '' : 'dev-insecure-jwt-secret-change-me'),
  /** Access token lifetime (seconds). Sessions are also checked server-side on every request. */
  accessTtlSec: Number(env('ACCESS_TOKEN_TTL_SEC', '600')),
  /** Absolute session lifetime (hours) regardless of activity. */
  sessionMaxHours: Number(env('SESSION_MAX_HOURS', '12')),
  /** 32-byte key (hex or base64) used to encrypt integration credentials and MFA secrets at rest (INT-01). */
  encryptionKey: env('APP_ENCRYPTION_KEY', isHardened || isProd ? '' : '0'.repeat(64)),
  uploadDir: env('UPLOAD_DIR', './uploads'),
  maxUploadMb: Number(env('MAX_UPLOAD_MB', '5')),
  /**
   * Client IP source. On Cloudflare Workers the edge sets CF-Connecting-IP (clients cannot override it), so it
   * is trusted there; in local Node.js tests it is trusted only when a test turns this on.
   */
  trustCfConnectingIp: typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers',
  /** Express "trust proxy". Off by default: client IP comes only from the authenticated proxy header. */
  trustProxy: process.env.TRUST_PROXY === undefined ? false : Number(process.env.TRUST_PROXY),
  enableApiDocs: (process.env.ENABLE_API_DOCS ?? (isHardened ? 'false' : 'true')) === 'true',
  jobsEnabled: env('JOBS_ENABLED', 'true') === 'true',
  /** Database hosts that non-production environments must never connect to (comma separated). */
  productionDbHosts: (process.env.PRODUCTION_DB_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
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
    // The sender must be on the domain verified in Resend (mail.nexoraed.com).
    from: process.env.MAIL_FROM || 'Nexora Academy <no-reply@mail.nexoraed.com>',
  },
};

export const KNOWN_WEAK_SECRETS = ['change-me', 'changeme', 'dev-insecure-jwt-secret-change-me', 'secret', 'jwt-secret'];

/**
 * R1 / SEC-07 / DEP-11 / DEP-18: refuse to boot staging or production with default or weak secrets.
 * Returns the list of problems (empty = OK). Pure function so it can be unit-tested.
 */
export function productionConfigProblems(e: NodeJS.ProcessEnv, target: AppEnv): string[] {
  if (target !== 'production' && target !== 'staging') return [];
  const p: string[] = [];
  const jwt = e.JWT_SECRET ?? '';
  if (Buffer.byteLength(jwt, 'utf8') < 32 || KNOWN_WEAK_SECRETS.includes(jwt.toLowerCase())) p.push('JWT_SECRET must be at least 32 random bytes (e.g. `openssl rand -hex 32`) and not a default value.');
  const key = e.APP_ENCRYPTION_KEY ?? '';
  const keyBuf = /^[0-9a-f]{64}$/i.test(key) ? Buffer.from(key, 'hex') : Buffer.from(key, 'base64');
  if (/^0+$/.test(key) || keyBuf.length !== 32 || keyBuf.every((b) => b === 0)) p.push('APP_ENCRYPTION_KEY must be 32 random bytes (64 hex chars) and not all zeros.');
  for (const k of ['PUBLIC_APP_URL', 'API_BASE_URL']) {
    const v = e[k] ?? '';
    if (!v.startsWith('https://') || /localhost|127\.0\.0\.1/.test(v)) p.push(`${k} must be an https:// URL that is not localhost.`);
  }
  const cors = (e.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!cors.length || cors.some((o) => !o.startsWith('https://') || /localhost|127\.0\.0\.1/.test(o))) p.push('CORS_ORIGINS must list only https:// origins (no localhost).');
  if (e.SEED_ADMIN_PASSWORD) p.push('SEED_ADMIN_PASSWORD is no longer supported; remove it and use `npm run admin:bootstrap`.');
  return p;
}

/** Refuse to connect a non-production environment to a production database (DEP-01/02). */
export function databaseIsolationProblem(url: string, target: AppEnv, prodHosts: string[]): string | null {
  if (target === 'production' || !prodHosts.length) return null;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return prodHosts.includes(host) ? `APP_ENV=${target} must not use the production database host ${host}.` : null;
}
