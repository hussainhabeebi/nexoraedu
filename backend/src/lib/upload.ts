/** File uploads with type & size limits (FR-DOC-01). Stored with random names outside the web root. */
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config';
import { badRequest } from './http';

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const root = path.resolve(config.uploadDir);
fs.mkdirSync(root, { recursive: true });

export const storedPath = (name: string) => {
  const p = path.join(root, path.basename(name));
  if (!p.startsWith(root + path.sep)) throw badRequest('Invalid path');
  return p;
};

export const upload = multer({
  storage: multer.diskStorage({
    destination: root,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(badRequest(`File type not allowed. Use PDF, JPG, PNG or WEBP up to ${config.maxUploadMb} MB.`) as any);
  },
});

/** Content sniffing: the declared type must match the file's real signature (S18, SEC-09). */
// A Map (not a plain object), so a declared type such as "constructor" or "__proto__" can never resolve to a
// built-in function and pass the check (CodeQL js/unvalidated-dynamic-method-call).
const SIGNATURES = new Map<string, (b: Buffer) => boolean>([
  ['application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
]);
/** Uploaded files must live directly in the upload directory (multer names them; never trust the path blindly). */
const uploadedPath = (filePath: string) => {
  const p = path.resolve(filePath);
  if (path.dirname(p) !== root) throw badRequest('Invalid upload path');
  return storedPath(path.basename(p));
};
export function fileMatchesType(filePath: string, mime: string): boolean {
  const check = SIGNATURES.get(mime);
  if (!check) return false;
  const fd = fs.openSync(uploadedPath(filePath), 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    return n >= 4 && check(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/** Express middleware placed after multer: rejects (and deletes) uploads whose content does not match their type. */
export function verifyUploads(req: any, _res: any, next: (e?: unknown) => void) {
  const files: Express.Multer.File[] = [...(req.file ? [req.file] : []), ...(Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat())];
  const bad = files.filter((f) => !fileMatchesType(f.path, f.mimetype));
  if (bad.length) {
    for (const f of files) fs.rmSync(uploadedPath(f.path), { force: true });
    return next(badRequest('One or more files are not valid PDF, JPG, PNG or WEBP files.'));
  }
  next();
}
