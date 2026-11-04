import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR', public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, 'BAD_REQUEST', d);
export const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND');
export const forbidden = (m = 'You do not have permission to perform this action') => new HttpError(403, m, 'FORBIDDEN');
export const conflict = (m: string, d?: unknown) => new HttpError(409, m, 'CONFLICT', d);

export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export function paging(q: Record<string, unknown>) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: { code: 'VALIDATION', message: 'Please correct the highlighted fields.', fields: err.flatten().fieldErrors },
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002')
      return res.status(409).json({ error: { code: 'DUPLICATE', message: `A record with this ${(err.meta?.target as string[] | undefined)?.join(', ') ?? 'value'} already exists.` } });
    if (err.code === 'P2025') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.' } });
  }
  const ref = crypto.randomBytes(4).toString('hex').toUpperCase();
  console.error(`[error ${ref}]`, req.method, req.originalUrl, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: `Something went wrong. Please try again or contact support with reference ${ref}.`, ref } });
}
