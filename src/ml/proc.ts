// Process helpers shared by src/ml/runs.ts and src/report/compile.ts (Node only, no vscode).

import { execFile } from 'child_process';

/** True when a process with this pid exists (signal 0 probe; EPERM also means it exists). */
export function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill a process and its children. Windows: `taskkill /PID <pid> /T /F`. POSIX: SIGTERM (then
 * SIGKILL after graceMs) to the process group when the process leads one (detached spawn), else
 * to the process. Resolves when done; never throws.
 */
export function killTree(pid: number, graceMs = 3000): Promise<void> {
  if (!isAlive(pid)) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);   // the whole group (detached children are group leaders)
    } catch {
      try { process.kill(pid, sig); } catch { /* gone */ }
    }
  };
  signal('SIGTERM');
  return new Promise(resolve => {
    const t0 = Date.now();
    const poll = () => {
      if (!isAlive(pid)) return resolve();
      if (Date.now() - t0 > graceMs) {
        signal('SIGKILL');
        return resolve();
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

