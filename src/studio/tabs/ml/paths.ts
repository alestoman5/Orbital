// Path checks shared by the ML and Report tab hosts: paths come from the
// webview, so they must resolve inside a workspace folder or be a file the
// user picked in a dialog (remembered here for the lifetime of the host).

import * as path from 'path';
import type { HostContext } from '../../context';
import { isAllowedPath, isInside } from '../../paths';

export { isInside };

const picked = new Set<string>();

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Remember files the user chose in a dialog (they may live outside the workspace). */
export function rememberPicked(paths: string[]): void {
  for (const p of paths) picked.add(norm(path.resolve(p)));
}

/**
 * Absolute path for a path from the webview: relative paths resolve against the first workspace
 * folder; the result must lie inside a workspace folder, inside one of `extraRoots`, or be a
 * picked file. Throws otherwise.
 */
export function resolveUserPath(ctx: HostContext, p: unknown, extraRoots: string[] = []): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('missing path');
  const folders = ctx.workspaceFolders();
  const abs = path.resolve(folders[0] ?? process.cwd(), p.trim());
  if (picked.has(norm(abs))) return abs;
  if (isAllowedPath(ctx, abs, extraRoots)) return abs;
  throw new Error(`path is outside the workspace: ${abs}`);
}
