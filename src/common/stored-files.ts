import * as fs from 'fs';
import * as path from 'path';
import type { Response } from 'express';

/**
 * Warehouse receipts are served by asking, not by URL.
 *
 * THE DEFECT THIS CLOSES
 *
 * `main.ts` mounted the uploads directory twice —
 * `useStaticAssets(uploadsDir, { prefix: '/uploads' })` and again under
 * `/api/uploads`. Both are express middleware, not routes, so no Nest guard
 * ran on either: every procurement and delivery receipt was readable by anyone
 * who could reach the service with the URL, signed in or not.
 *
 * Receipts name suppliers, quantities and prices. A UUID in a path is not
 * authorization, and a URL outlives the access of whoever was given it.
 *
 * THE MODEL — the one CRM adopted in Phase 4B.5 and finance now shares
 *
 *   browser → GET /uploads/<name>  (unchanged: rows store a relative path)
 *           → who is asking, header or session cookie
 *           → which order or delivery points at <name>
 *           → may this person read procurement at all
 *           → yes: stream; no, or nothing points at it: 404, identical.
 */

export const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

/** Who is asking for a file. */
export interface FileRequester {
  userId: number;
  authorization: string;
}

/**
 * A stored name, as the URL carried it. Only a plain name directly inside the
 * directory: no separators, no dot-names, no NUL, nothing that climbs out.
 * `storedPath` then proves the resolved path is still inside the root, so an
 * encoding this misses cannot escape either.
 */
export function isStoredName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (name === '.' || name === '..' || name.startsWith('.')) return false;
  if (/[\/\\\0]/.test(name) || name.includes('..')) return false;
  return path.basename(name) === name;
}

/** The stored name inside a stored path — `/uploads/abc.pdf` → `abc.pdf`. */
export function storedNameOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const at = url.lastIndexOf('/uploads/');
  if (at < 0) return null;
  const name = url.slice(at + '/uploads/'.length).split(/[?#]/)[0];
  return isStoredName(name) ? name : null;
}

/**
 * The path on disk, or null.
 *
 * The resolved real path must sit directly inside the storage root, so a
 * symlink planted in the directory and pointing elsewhere is refused rather
 * than followed out of it.
 */
export function storedPath(dir: string, name: string): string | null {
  if (!isStoredName(name)) return null;
  const root = path.resolve(dir);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) return null;
  try {
    const real = fs.realpathSync(target);
    if (path.dirname(path.resolve(real)) !== root) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Types a browser may render in place. Everything else is a download. */
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/**
 * Stream a file that has been authorized.
 *
 * `private, no-cache` keeps it out of shared caches and makes the browser
 * revalidate, which puts every reuse back through authorization. The type
 * comes from the extension, never the bytes (`nosniff`); anything not inline
 * is an attachment under a sandboxing CSP, so an uploaded document cannot run
 * as this origin.
 */
export function sendStoredFile(res: Response, absPath: string): void {
  const ext = path.extname(absPath).toLowerCase();
  const inline = INLINE_TYPES[ext];
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (inline) {
    res.type(inline);
    res.setHeader('Content-Disposition', 'inline');
  } else {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  res.sendFile(absPath, { dotfiles: 'deny', cacheControl: false, lastModified: true, etag: true });
}

/** The session cookie auth-api sets. */
export const SESSION_COOKIE = 'nairon_session';

/** The caller's token: an Authorization Bearer header first, else the session cookie. */
export function requestToken(req: { headers?: Record<string, unknown> }): string | null {
  const [type, token] = String(req.headers?.authorization ?? '').split(' ');
  if (type === 'Bearer' && token) return token;
  const cookie = String(req.headers?.cookie ?? '');
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
