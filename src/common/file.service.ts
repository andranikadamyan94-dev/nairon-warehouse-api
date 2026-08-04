import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const SAFE_EXT_RE = /^\.[a-z0-9]+$/i;

/**
 * Stored files are referenced by a path relative to the API root, never by an
 * absolute URL.
 *
 * This used to return `${PUBLIC_API_URL}/uploads/...`, with PUBLIC_API_URL
 * unset everywhere — so staging persisted `http://localhost:3005/uploads/...`
 * into the database and every receipt link pointed at the reader's own
 * machine. Baking a hostname into stored data makes it wrong in every
 * environment except the one that wrote it; a relative path is correct in all
 * of them, and the client resolves it against whatever API base it is using.
 */
const UPLOADS_PATH = '/uploads';

@Injectable()
export class FileService {
  upload(file: Express.Multer.File): string {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(`File type not allowed: ${file.mimetype}`);
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(`File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`);
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext && !SAFE_EXT_RE.test(ext)) {
      throw new BadRequestException('Invalid file extension');
    }
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const filename = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
    return `${UPLOADS_PATH}/${filename}`;
  }
}
