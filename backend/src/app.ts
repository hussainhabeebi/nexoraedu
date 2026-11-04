import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { ah, errorHandler, notFound } from './lib/http';
import { authenticate, can } from './lib/auth';
import { prisma } from './lib/prisma';
import { storedPath } from './lib/upload';
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

export function createApp() {
  registerHandlers();
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb', verify: (req: any, _res, buf) => (req.rawBody = buf.toString('utf8')) }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan(config.isProd ? 'combined' : 'dev'));

  // API-06 rate limiting per IP (auth endpoints have stricter limits)
  app.use('/api/', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Please slow down.' } } }));

  app.get('/health', ah(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, time: new Date() });
  }));
  app.get('/api/v1/openapi.json', (_req, res) => res.json(openapi));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi));

  const v1 = express.Router();
  v1.use('/auth', authRoutes);
  v1.use('/public', publicRoutes);
  v1.use('/webhooks', webhookRoutes);
  // Public profile photos only (documents are served through authenticated endpoints)
  v1.get('/files/:name', ah(async (req, res) => {
    const name = req.params.name;
    const isDoc = await prisma.document.findFirst({ where: { storagePath: name }, select: { id: true } });
    const p = storedPath(name);
    if (isDoc || !fs.existsSync(p)) throw notFound();
    res.sendFile(p);
  }));

  v1.use(authenticate);
  v1.use('/admin', adminRoutes);
  v1.use('/academics', academicsRoutes);
  v1.use('/crm', crmRoutes);
  v1.use('/students', studentRoutes);
  v1.use('/documents', documentsRouter);
  v1.use('/finance', financeRoutes);
  v1.use('/exams', examRoutes);
  v1.use('/approvals', can('approvals:act', 'leads:create', 'finance:collect', 'students:manage', 'exams:manage', 'attendance:mark', 'academics:manage'), approvalRoutes);
  v1.use('/notifications', notificationRoutes);
  v1.use('/whatsapp', whatsappRoutes);
  v1.use('/dashboard', dashboardRoutes);
  v1.use('/portal', portalRoutes);
  app.use('/api/v1', v1);

  app.use((_req, _res, next) => next(notFound('The requested resource was not found.')));
  app.use(errorHandler);
  return app;
}
