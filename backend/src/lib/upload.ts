/**
 * File uploads with type & size limits (FR-DOC-01). Files are checked in memory and then stored privately in R2
 * under a random name; nothing is written to local disk.
 */
import multer from 'multer';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { Response } from 'express';
import { config } from '../config';
import { badRequest } from './http';
import { getFile, isStoredName, putFile } from './files';

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const EXT: Record<string, string> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(badRequest(`File type not allowed. Use PDF, JPG, PNG or WEBP up to ${config.maxUploadMb} MB.`) as any);
  },
});

/**
 * Content sniffing: the declared type must match the file's real signature (S18, SEC-09).
 * A fixed switch (no lookup by the client-declared name), so an unexpected type can only ever return false.
 */
function signatureMatches(mime: string, b: Buffer): boolean {
  switch (mime) {
    case 'application/pdf': return b.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/png': return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/webp': return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
}
export function bufferMatchesType(buf: Buffer, mime: string): boolean {
  return ALLOWED.includes(mime) && buf.length >= 4 && signatureMatches(mime, buf.subarray(0, 16));
}

/**
 * Express middleware placed after multer: rejects uploads whose content does not match their type, then stores
 * the accepted files in R2. Afterwards `file.filename` (and `file.path`) is the stored name.
 */
export function verifyUploads(req: any, _res: any, next: (e?: unknown) => void) {
  const list: Express.Multer.File[] = [...(req.file ? [req.file] : []), ...(Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat())] as Express.Multer.File[];
  if (list.some((f) => !bufferMatchesType(f.buffer, f.mimetype))) return next(badRequest('One or more files are not valid PDF, JPG, PNG or WEBP files.'));
  Promise.all(
    list.map(async (f) => {
      const name = crypto.randomBytes(16).toString('hex') + EXT[f.mimetype];
      await putFile(name, new Uint8Array(f.buffer), f.mimetype);
      f.filename = name;
      f.path = name;
    }),
  ).then(() => next(), next);
}

/** Stored name check for names read from the database (never a path). */
export const storedName = (name: string) => {
  if (!isStoredName(name)) throw badRequest('Invalid file reference');
  return name;
};

/** Streams a stored file to the response; returns false when it does not exist. */
export async function sendStoredFile(res: Response, name: string): Promise<boolean> {
  const obj = await getFile(storedName(name));
  if (!obj) return false;
  res.setHeader('Content-Length', String(obj.size));
  Readable.fromWeb(obj.body as any).pipe(res);
  return true;
}
