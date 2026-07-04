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

function getBaseUrl(): string {
  return (process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3005}`).replace(/\/$/, '');
}

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
    return `${getBaseUrl()}/uploads/${filename}`;
  }
}
