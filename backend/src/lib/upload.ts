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
  if (!p.startsWith(root)) throw badRequest('Invalid path');
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
