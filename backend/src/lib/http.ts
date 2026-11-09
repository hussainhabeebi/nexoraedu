import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { Prisma } from '#prisma';
import crypto from 'node:crypto';

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

/** Uniform error format {code, message, details, ref} where ref = X-Request-Id (API-02, UI-23/24). */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const ref = req.id ?? crypto.randomUUID();
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: { code: 'VALIDATION', message: 'Please correct the highlighted fields.', fields: err.flatten().fieldErrors, ref },
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, ref } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002')
      return res.status(409).json({ error: { code: 'DUPLICATE', message: `A record with this ${(err.meta?.target as string[] | undefined)?.join(', ') ?? 'value'} already exists.`, ref } });
    if (err.code === 'P2034') return res.status(409).json({ error: { code: 'BUSY', message: 'This record is being changed by someone else. Please try again.', ref } });
    if (err.code === 'P2025') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.', ref } });
  }
  if ((err as any)?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.', ref } });
  // Path only (no query string) so secrets never land in error logs.
  console.error(`[error ${ref}]`, req.method, String(req.originalUrl).split('?')[0], err);
  res.status(500).json({ error: { code: 'INTERNAL', message: `Something went wrong. Please try again or contact support with reference ${ref}.`, ref } });
}
