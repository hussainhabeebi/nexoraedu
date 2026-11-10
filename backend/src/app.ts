import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { config, isHardened } from './config';
import { ah, errorHandler, HttpError, notFound } from './lib/http';
import { authenticate, can, requireCompleteSession } from './lib/auth';
import { prisma } from './lib/prisma';
import { sendStoredFile } from './lib/upload';
import { InstanceMemoryStore } from './lib/rate-store';
import { canAccessStudent } from './lib/policy';
import { registerHandlers } from './services/handlers';
import { openapi } from './openapi';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import academicsRoutes from './routes/academics';
import crmRoutes from './routes/crm';
import studentRoutes, { documentsRouter } from './routes/students';
import financeRoutes from './routes/finance';
import examRoutes from './routes/exams';
import approvalRoutes from './routes/approvals';
import notificationRoutes from './routes/notifications';
import whatsappRoutes from './routes/whatsapp';
import webhookRoutes from './routes/webhooks';
import dashboardRoutes from './routes/dashboard';
import publicRoutes from './routes/public';
import portalRoutes from './routes/portal';
import parentRoutes from './routes/parent';

/** Path without query string, so secrets in query parameters never reach access logs (LOG-02). */
morgan.token('path', (req: any) => String(req.originalUrl || req.url).split('?')[0]);
morgan.token('rid', (req: any) => req.id);
const LOG_FORMAT = ':remote-addr - :method :path :status :res[content-length] - :response-time ms rid=:rid';

export function createApp() {
  registerHandlers();
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Request / correlation ID (API-02, UI-24, 24.7)
  app.use((req, res, next) => {
    const inbound = req.get('x-request-id');
    req.id = inbound && /^[\w-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // Real client IP from Cloudflare's CF-Connecting-IP only (set by the edge; X-Forwarded-For / X-Client-IP from
  // the client are ignored). The API is served by the same Worker as the site, so there is no separate origin (S17).
  app.use((req, _res, next) => {
    const ip = config.trustCfConnectingIp ? req.get('cf-connecting-ip') : undefined;
    Object.defineProperty(req, 'ip', { value: ip || (config.trustCfConnectingIp ? 'unknown' : req.socket?.remoteAddress ?? 'unknown'), configurable: true });
    next();
  });

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-origin' } }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb', verify: (req: any, _res, buf) => (req.rawBody = buf.toString('utf8')) }));
  if (config.appEnv !== 'test') app.use(morgan(LOG_FORMAT));

  // API-06 rate limiting per IP (auth endpoints have stricter limits)
  app.use('/api/', rateLimit({ windowMs: 60_000, limit: Number(process.env.API_RATE_LIMIT || 600), standardHeaders: true, legacyHeaders: false, store: new InstanceMemoryStore(), message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Please slow down.' } } }));

  app.get('/health', ah(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, time: new Date() });
  }));
  if (config.enableApiDocs) {
    app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
    // Swagger UI reads its files from disk, which a Worker does not have: the spec itself is served instead.
    app.get('/api/docs', (_req, res) => res.redirect('/api/v1/openapi.json'));
  }

  const v1 = express.Router();
  v1.use('/auth', authRoutes);
  v1.use('/public', publicRoutes);
  v1.use('/webhooks', webhookRoutes);

  v1.use(authenticate);
  // Business APIs need a complete session: MFA verified where required and no pending forced password change.
  v1.use(requireCompleteSession);

  // Student profile photos: authenticated and scoped (S18). Documents are never served here.
  v1.get('/files/:name', ah(async (req, res) => {
    const name = req.params.name;
    const st = await prisma.student.findFirst({ where: { photoUrl: `/api/v1/files/${name}` }, select: { id: true } });
    if (!st || !(req.user!.studentId === st.id || (await canAccessStudent(req.user!, st.id)))) throw notFound();
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', /\.png$/.test(name) ? 'image/png' : /\.webp$/.test(name) ? 'image/webp' : /\.pdf$/.test(name) ? 'application/pdf' : 'image/jpeg');
    if (!(await sendStoredFile(res, name))) throw notFound();
  }));

  v1.use('/admin', adminRoutes);
  v1.use('/academics', academicsRoutes);
  v1.use('/crm', crmRoutes);
  v1.use('/students', studentRoutes);
  v1.use('/documents', documentsRouter);
  v1.use('/finance', financeRoutes);
  v1.use('/exams', examRoutes);
  v1.use('/approvals', can('approvals:act', 'leads:create', 'finance:collect', 'students:manage', 'exams:manage', 'attendance:mark', 'academics:manage', 'users:manage'), approvalRoutes);
  v1.use('/notifications', notificationRoutes);
  v1.use('/whatsapp', whatsappRoutes);
  v1.use('/dashboard', dashboardRoutes);
  v1.use('/portal', portalRoutes);
  v1.use('/parent', parentRoutes);
  app.use('/api/v1', v1);

  app.use((_req, _res, next) => next(notFound('The requested resource was not found.')));
  app.use(errorHandler);
  return app;
}
