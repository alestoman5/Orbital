// Small filesystem-path helpers shared across the .out tooling (status bar,
// Avogadro hand-off, CodeLens...). Pure Node `path` logic, no `vscode`
// import, so it's usable from both extension code and tests.

import * as path from 'path';

/** Given "/foo/bar/job.inp" (or any path), returns "/foo/bar/job.out". */
export function getOutPathForBasename(anyPath: string): string {
  const dir = path.dirname(anyPath);
  const base = path.basename(anyPath, path.extname(anyPath));
  return path.join(dir, `${base}.out`);
}

/** Given "/foo/bar/job.out" (or any path), returns "/foo/bar/job.xyz". */
export function getXyzPathForBasename(anyPath: string): string {
  const dir = path.dirname(anyPath);
  const base = path.basename(anyPath, path.extname(anyPath));
  return path.join(dir, `${base}.xyz`);
}

/** True if `a` and `b` share the same directory + basename (ignoring extension). */
export function sameBasename(a: string, b: string): boolean {
  const dirA = path.dirname(a);
  const dirB = path.dirname(b);
  const baseA = path.basename(a, path.extname(a));
  const baseB = path.basename(b, path.extname(b));
  return dirA === dirB && baseA === baseB;
}
