import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

/** Display names are stored in a plain String column; keep them to a sane length. */
export const MAX_FILE_NAME_LENGTH = 200;

/**
 * The display name a rename may store. Only the base is the user's to change:
 * whatever they typed, the stored file's extension is re-appended, so a rename
 * can never turn a .pdf into a .exe (or drop the format). The stored object
 * itself is never touched — this is a label.
 */
export function renamedFileName(currentName: string, typed: unknown): string {
  if (typeof typed !== 'string') throw new BadRequestException('Անվանումը պարտադիր է');
  const ext = path.extname(currentName ?? '');
  const raw = typed.trim();
  // Drop a trailing extension the user typed; the stored one is authoritative.
  const base = (ext && raw.toLowerCase().endsWith(ext.toLowerCase()) ? raw.slice(0, -ext.length) : raw)
    .replace(/[\\/\u0000-\u001f]/g, '')
    .trim();
  if (!base) throw new BadRequestException('Անվանումը պարտադիր է');
  const name = `${base}${ext}`;
  if (name.length > MAX_FILE_NAME_LENGTH) {
    throw new BadRequestException(`Անվանումը չափազանց երկար է (առավելագույնը՝ ${MAX_FILE_NAME_LENGTH} նիշ)`);
  }
  return name;
}
