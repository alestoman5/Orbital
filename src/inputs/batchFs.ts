// Writes a planned batch (batch.ts planBatch) to disk. The only module of
// src/inputs that touches the file system; host side only.

import * as fs from 'fs';
import * as path from 'path';
import { BatchFile } from './batch';

export interface WriteBatchOptions {
  /** Replace files that already exist (default false: refuse and write nothing). */
  overwrite?: boolean;
}

/** Writes `files` below `root`; returns the absolute paths written. */
export function writeBatch(root: string, files: BatchFile[], options: WriteBatchOptions = {}): string[] {
  const absRoot = path.resolve(root);
  const targets = files.map(f => {
    const rel = f.relPath.replace(/\\/g, '/');
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
      throw new Error(`Refusing to write outside the batch folder: ${f.relPath}`);
    }
    return { file: f, abs: path.join(absRoot, ...rel.split('/')) };
  });
  if (!options.overwrite) {
    const existing = targets.filter(t => fs.existsSync(t.abs)).map(t => t.file.relPath);
    if (existing.length > 0) {
      const shown = existing.slice(0, 5).join(', ') + (existing.length > 5 ? `, … (${existing.length} in total)` : '');
      throw new Error(`Files already exist in ${absRoot}: ${shown}. Nothing was written; pass overwrite to replace them.`);
    }
  }
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.abs), { recursive: true });
    fs.writeFileSync(t.abs, t.file.content.replace(/\r\n/g, '\n'));
    if (t.file.executable) {
      try {
        fs.chmodSync(t.abs, 0o755);
      } catch {
        // not supported on this file system (e.g. Windows): harmless
      }
    }
  }
  return targets.map(t => t.abs);
}
