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

/**
 * What a route accepts. `attachment` is the historical rule (receipts and
 * requisition attachments); the catalog (2026-10-01) adds a gallery image and
 * an item document, each narrower than it.
 */
export type UploadKind = 'attachment' | 'image' | 'document';

const RULES: Record<UploadKind, { mimeTypes: Set<string>; maxSize: number }> = {
  attachment: { mimeTypes: ALLOWED_MIME_TYPES, maxSize: MAX_FILE_SIZE },
  image: { mimeTypes: new Set(['image/jpeg', 'image/png', 'image/webp']), maxSize: 5 * 1024 * 1024 },
  document: {
    mimeTypes: new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]),
    maxSize: 10 * 1024 * 1024,
  },
};

@Injectable()
export class FileService {
  upload(file: Express.Multer.File, kind: UploadKind = 'attachment'): string {
    const rule = RULES[kind];
    if (!rule.mimeTypes.has(file.mimetype)) {
      throw new BadRequestException(`Ֆայլի տեսակը թույլատրված չէ՝ ${file.mimetype}`);
    }
    if (file.size > rule.maxSize) {
      throw new BadRequestException(`Ֆայլը չափազանց մեծ է (առավելագույնը ${rule.maxSize / 1024 / 1024} ՄԲ)`);
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext && !SAFE_EXT_RE.test(ext)) {
      throw new BadRequestException('Ֆայլի ընդլայնումն անթույլատրելի է');
    }
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const filename = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
    return `${UPLOADS_PATH}/${filename}`;
  }

  /**
   * Remove a stored file nothing points at any more. Best effort: a missing
   * file is already gone, and the row is what grants access, so a leftover
   * file is unreachable either way.
   */
  remove(url: string | null | undefined): void {
    const name = typeof url === 'string' ? url.slice(url.lastIndexOf('/') + 1) : '';
    if (!name || name.includes('..') || /[\\/\0]/.test(name)) return;
    try {
      fs.unlinkSync(path.join(UPLOADS_DIR, name));
    } catch {
      /* already gone */
    }
  }
}
