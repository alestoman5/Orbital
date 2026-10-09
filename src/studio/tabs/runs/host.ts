// Host side of the "runs" studio tab: running calculation processes (ps on
// Linux/macOS, PowerShell CIM query on Windows), the machine's load and
// memory, the SLURM queue when squeue exists, and the newest log files with
// a tail. Generalizes uv-vis webapp/v_runs.py. Must not import 'vscode'.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext, TabHost } from '../../context';
import { isInside } from '../calcs/host';
import { mergeGlobs } from './glob';
import {
  CpuSample, DEFAULT_PROCESS_PATTERN, SQUEUE_FORMAT, WINDOWS_PS_SCRIPT, compilePattern, cpuUtilization, filterProcesses, lastLines,
  parseMemAvailable, parsePs, parseSqueue, parseWindowsProcesses
} from './procs';
import type { KillParams, KillResult, LogFile, LogsResult, MachineInfo, ProcRow, ProcessesResult, QueueResult, TailParams, TailResult } from './types';

export const DEFAULT_LOG_GLOBS = ['**/*.log', '**/*.out', '**/output'];
export const DEFAULT_LOG_EXCLUDES = ['**/geom_*/**'];
const DEFAULT_EXCLUDE = '**/{node_modules,.git}/**';
const LOG_LIMIT = 50;
const MAX_TAIL_LINES = 50000;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

interface Exec {
  stdout: string;
  pid?: number;
}

/** Runs a program without a shell; rejects with err.code 'ENOENT' when it is missing. */
export function run(cmd: string, args: string[], timeoutMs = 10000): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        e.stderr = stderr;
        reject(e);
      } else {
        resolve({ stdout, pid: child.pid });
      }
    });
  });
}

const LINUX_COLS = ['pid', 'ppid', 'user:32', 'pcpu', 'pmem', 'rss', 'nlwp', 'etime', 'args'];
const BSD_COLS = ['pid', 'ppid', 'user', 'pcpu', 'pmem', 'rss', 'etime', 'args'];
const keyOf = (c: string) => c.split(':')[0];

/** Linux (procps), else BSD/macOS ps, else Windows PowerShell. */
async function listAllProcesses(prevCpu: CpuSample | undefined): Promise<{ rows: ProcRow[]; helper?: number; cpuNote: string; sample?: CpuSample }> {
  if (process.platform === 'win32') {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PS_SCRIPT], 15000);
    const { rows, sample } = parseWindowsProcesses(r.stdout, Date.now(), os.totalmem(), prevCpu);
    return { rows, helper: r.pid, sample, cpuNote: prevCpu ? 'since the previous refresh, % of one core' : 'lifetime average, % of one core' };
  }
  if (process.platform !== 'darwin') {
    try {
      const r = await run('ps', ['-eww', '-o', LINUX_COLS.join(','), '--sort=-pcpu']);
      return { rows: parsePs(r.stdout, LINUX_COLS.map(keyOf)), helper: r.pid, cpuNote: 'ps %CPU: lifetime average, % of one core' };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ps is not available on this system');
      // Not procps (BusyBox, BSD): fall through to the portable form.
    }
  }
  const r = await run('ps', ['-axww', '-o', BSD_COLS.join(',')]);
  return { rows: parsePs(r.stdout, BSD_COLS), helper: r.pid, cpuNote: 'ps %CPU: decaying average, % of one core' };
}

function memInfo(): { total: number; used: number } {
  const total = os.totalmem();
  let avail = os.freemem();
  if (process.platform === 'linux') {
    try {
      avail = parseMemAvailable(fs.readFileSync('/proc/meminfo', 'utf8')) ?? avail;
    } catch {
      // keep freemem
    }
  }
  return { total, used: Math.max(0, total - avail) };
}

/** The last `lines` lines of a file, reading backwards in blocks. */
export function readTail(file: string, lines: number): Omit<TailResult, 'path'> {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const size = st.size;
    let pos = size;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (pos > 0 && newlines <= lines && size - pos < MAX_TAIL_BYTES) {
      const len = Math.min(65536, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      for (let i = 0; i < len; i++) if (buf[i] === 10) newlines++;
      chunks.unshift(buf);
    }
    let text = Buffer.concat(chunks).toString('utf8').replace(/\r\n?/g, '\n').replace(/\0/g, '');
    if (pos > 0) text = text.slice(text.indexOf('\n') + 1);
    const t = lastLines(text, lines);
    return { text: t.text, lines: t.lines, more: t.cut || pos > 0, size, mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

export function createRunsHost(): TabHost {
  let prevCpus: os.CpuInfo[] | undefined;
  let prevProcCpu: CpuSample | undefined;
  let squeueMissing = false;
  const userName = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USER ?? process.env.USERNAME ?? '';
    }
  })();

  const processes = async (ctx: HostContext): Promise<ProcessesResult> => {
    const t0 = Date.now();
    const pat = compilePattern(ctx.config<string>('studio.processPattern', DEFAULT_PROCESS_PATTERN));
    const base: ProcessesResult = { rows: [], scanned: 0, pattern: pat.source, platform: process.platform, cpuNote: '', durationMs: 0 };
    if (pat.error) base.patternError = pat.error;
    try {
      const all = await listAllProcesses(prevProcCpu);
      if (all.sample) prevProcCpu = all.sample;
      const own = new Set<number>([process.pid]);
      if (all.helper) own.add(all.helper);
      base.rows = filterProcesses(all.rows, pat.re, own);
      base.scanned = all.rows.length;
      base.cpuNote = all.cpuNote;
    } catch (e) {
      base.error = e instanceof Error ? e.message : String(e);
    }
    base.durationMs = Date.now() - t0;
    return base;
  };

  const logExcludes = (ctx: HostContext) => {
    const v = ctx.config<string[]>('studio.logExcludeGlobs', DEFAULT_LOG_EXCLUDES);
    return Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()) : DEFAULT_LOG_EXCLUDES;
  };

  const checkLogPath = (ctx: HostContext, p: unknown): string => {
    if (typeof p !== 'string' || !p) throw new Error('path is required');
    const file = path.resolve(p);
    if (!ctx.workspaceFolders().some(w => isInside(file, w))) throw new Error(`${file} is outside the workspace`);
    return file;
  };

  return {
    id: 'runs',
    methods: {
      processes: (_p: unknown, ctx) => processes(ctx),

      async machine(): Promise<MachineInfo> {
        let a = prevCpus;
        if (!a) {
          a = os.cpus();
          await new Promise(r => setTimeout(r, 250));
        }
        const b = os.cpus();
        prevCpus = b;
        const mem = memInfo();
        const info: MachineInfo = {
          hostname: os.hostname(),
          platform: process.platform,
          release: os.release(),
          cores: b.length,
          cpuModel: (b[0]?.model ?? '').replace(/\s+/g, ' ').trim(),
          cpuPercent: Math.round(cpuUtilization(a, b) * 10) / 10,
          memTotal: mem.total,
          memUsed: mem.used,
          uptimeS: Math.round(os.uptime()),
          user: userName
        };
        if (process.platform !== 'win32') info.loadavg = os.loadavg() as [number, number, number];
        return info;
      },

      async queue(): Promise<QueueResult> {
        const res: QueueResult = { available: false, user: userName, jobs: [] };
        if (squeueMissing) return res;
        try {
          const r = await run('squeue', ['-u', userName, '-h', '-o', SQUEUE_FORMAT], 8000);
          res.available = true;
          res.jobs = parseSqueue(r.stdout);
        } catch (e) {
          const err = e as NodeJS.ErrnoException & { stderr?: string };
          if (err.code === 'ENOENT') {
            squeueMissing = true;
          } else {
            res.available = true;
            res.error = (err.stderr || err.message || String(e)).trim().split('\n')[0];
          }
        }
        return res;
      },

      /** Signal a listed process; the webview asks for confirmation first. */
      async kill(params: KillParams, ctx): Promise<KillResult> {
        const pid = Number(params?.pid);
        const signal = params?.signal === 'KILL' ? 'KILL' : 'TERM';
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) throw new Error(`refusing to signal pid ${params?.pid}`);
        const listed = await processes(ctx);
        const row = listed.rows.find(r => r.pid === pid);
        if (!row) return { ok: false, message: `PID ${pid} is no longer running (or no longer matches the process pattern)` };
        if (process.platform === 'win32') {
          try {
            await run('taskkill', ['/PID', String(pid), '/T', ...(signal === 'KILL' ? ['/F'] : [])], 10000);
            return { ok: true, message: `${signal === 'KILL' ? 'Killed' : 'Asked to stop'} ${row.name} (PID ${pid}) and its child processes` };
          } catch (e) {
            const err = e as Error & { stderr?: string; stdout?: string };
            const msg = (err.stderr || err.message).trim().split('\n').pop() ?? '';
            return { ok: false, message: signal === 'TERM' ? `${msg} — use Force kill` : msg };
          }
        }
        try {
          process.kill(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
          return { ok: true, message: `Sent SIG${signal} to ${row.name} (PID ${pid})` };
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          return { ok: false, message: code === 'EPERM' ? `Permission denied for PID ${pid} (owned by ${row.user ?? 'another user'})` : code === 'ESRCH' ? `PID ${pid} has already exited` : String(e) };
        }
      },

      /** The newest log files (studio.logGlobs minus studio.logExcludeGlobs), at most 50. */
      async logs(_p: unknown, ctx): Promise<LogsResult> {
        const t0 = Date.now();
        const globsSetting = ctx.config<string[]>('studio.logGlobs', DEFAULT_LOG_GLOBS);
        const globs = Array.isArray(globsSetting) && globsSetting.length ? globsSetting.filter(s => typeof s === 'string' && s.trim()) : DEFAULT_LOG_GLOBS;
        const excludes = logExcludes(ctx);
        const exclude = mergeGlobs([ctx.config<string>('runs.exclude', DEFAULT_EXCLUDE), ...excludes]);
        const found = new Set<string>();
        for (const w of ctx.workspaceFolders()) {
          const lists = await Promise.all(globs.map(g => ctx.findFiles(g, { base: w, exclude })));
          lists.flat().forEach(f => found.add(f));
        }
        const files: LogFile[] = [];
        for (const f of found) {
          const st = fs.statSync(f, { throwIfNoEntry: false });
          if (!st?.isFile()) continue;
          const root = ctx.workspaceFolders().find(w => isInside(f, w)) ?? path.dirname(f);
          files.push({ path: f, rel: path.relative(root, f).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
        }
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return { files: files.slice(0, LOG_LIMIT), total: files.length, limit: LOG_LIMIT, globs, exclude: excludes, durationMs: Date.now() - t0 };
      },

      /** Last lines of a workspace file; { unchanged } when size and mtime match `since`. */
      tail(params: TailParams, ctx): TailResult {
        const file = checkLogPath(ctx, params?.path);
        const st = fs.statSync(file, { throwIfNoEntry: false });
        if (!st?.isFile()) throw new Error(`${file} does not exist`);
        const since = params?.since;
        if (since && since.size === st.size && since.mtimeMs === st.mtimeMs) {
          return { path: file, unchanged: true, text: '', lines: 0, more: false, size: st.size, mtimeMs: st.mtimeMs };
        }
        const n = Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(Number(params?.lines) || 200)));
        return { path: file, ...readTail(file, n) };
      },

      settings(_p: unknown, ctx) {
        return {
          processPattern: ctx.config<string>('studio.processPattern', DEFAULT_PROCESS_PATTERN),
          logGlobs: ctx.config<string[]>('studio.logGlobs', DEFAULT_LOG_GLOBS),
          logExcludeGlobs: logExcludes(ctx)
        };
      }
    }
  };
}

export const host: TabHost = createRunsHost();
