// Path policy shared by all tab hosts. Paths from the webview are untrusted:
// they must resolve inside a workspace folder, or inside something the user
// chose (a file dialog or the argument of a command run from a menu).
// Containment is checked on real paths, so a symlink or junction inside the
// workspace that points elsewhere does not count as inside.

import * as fs from 'fs';
import * as path from 'path';
import type { HostContext } from './context';

const caseless = process.platform === 'win32' || process.platform === 'darwin';
const fold = (p: string) => (caseless ? p.toLowerCase() : p);

/** Lexical containment: is `child` equal to or below `parent`? (No file system access.) */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Real path of `p`; for a path that does not exist yet, the real path of its nearest existing ancestor plus the rest. */
export function realPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

/** Containment on real paths (symlinks and junctions resolved). */
export function isReallyInside(child: string, parent: string): boolean {
  return isInside(realPath(child), realPath(parent));
}

const chosen = new Set<string>();

/** Remember paths the user chose (dialogs, command arguments); files below a chosen folder are allowed too. */
export function allowUserPaths(paths: Iterable<string>): void {
  for (const p of paths) {
    if (typeof p === 'string' && p && path.isAbsolute(p)) {
      chosen.add(fold(path.resolve(p)));
    }
  }
}

/** Is `p` a path the user chose, or below a folder they chose? */
export function isUserChosen(p: string): boolean {
  if (chosen.has(fold(path.resolve(p)))) return true;
  return [...chosen].some(c => isInside(p, c));
}

/** Is `p` inside a workspace folder (real paths), inside one of `extraRoots`, or user-chosen? */
export function isAllowedPath(ctx: HostContext, p: string, extraRoots: string[] = []): boolean {
  if (isUserChosen(p)) return true;
  return [...ctx.workspaceFolders(), ...extraRoots].some(root => isReallyInside(p, root));
}

/** Forget the chosen paths (tests). */
export function clearUserPaths(): void {
  chosen.clear();
}

/** Absolute paths found in command arguments (`files`, `folder`, `dat`, `texFile`, `geometryFile`, …). */
export function pathsInArgs(args: unknown): string[] {
  const out: string[] = [];
  if (!args || typeof args !== 'object') return out;
  for (const v of Object.values(args as Record<string, unknown>)) {
    for (const s of Array.isArray(v) ? v : [v]) {
      if (typeof s === 'string' && path.isAbsolute(s)) out.push(s);
    }
  }
  return out;
}
