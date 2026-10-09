// Pure parsers of the runs tab: `ps` output (Linux procps, macOS BSD ps),
// the JSON of the PowerShell process query, `squeue` output, and the
// default pattern that picks calculation processes. No Node or vscode
// imports, so they are unit-tested with captured outputs.

import type { ProcRow, QueueJob } from './types';

/**
 * Default `studio.processPattern`: quantum-chemistry programs started as a
 * command (orca, orca_*, xtb, crest, g16, cp2k, abin, psi4, MPI / SLURM
 * launchers), and Python running PySCF or the uv-vis / Orbital scripts.
 * Matched case-insensitively against "<name> <command line>".
 */
export const DEFAULT_PROCESS_PATTERN =
  '(^|[\\\\/\\s"\'])(orca(_\\w+)?|xtb|crest|g16|g09|gaussian|cp2k(\\.\\w+)?|abin|psi4|mpirun|mpiexec|srun|pyscf)(\\.exe)?(?=$|[\\s"\'])'
  + '|python[\\d.]*(\\.exe)?["\']?\\s.*(pyscf|run_|ml_worker|from_geometry|from_ensemble|compare_ensembles)';

/** "[[dd-]hh:]mm:ss" (ps etime) → seconds. */
export function parseEtime(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  const [, d, h, mi, se] = m;
  return (Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(mi) * 60 + Number(se);
}

const firstWord = (cmd: string) => {
  const w = cmd.trim().split(/\s+/)[0] ?? '';
  return w.split(/[\\/]/).pop() ?? w;
};

/**
 * Rows of `ps -o <columns>` output with a header line. `columns` are the
 * ps keywords in order; the last one must be `args` (rest of the line).
 * Known keywords: pid, ppid, user, pcpu, pmem, rss (KiB), nlwp, etime, args.
 */
export function parsePs(text: string, columns: string[]): ProcRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return [];
  const body = /^\s*PID\b/i.test(lines[0]) ? lines.slice(1) : lines;
  const n = columns.length;
  const rows: ProcRow[] = [];
  for (const line of body) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < n - 1) continue;
    const fields = parts.slice(0, n - 1);
    const args = parts.slice(n - 1).join(' ');
    const get = (k: string) => fields[columns.indexOf(k)];
    const pid = Number(get('pid'));
    if (!Number.isInteger(pid)) continue;
    const num = (k: string) => {
      if (!columns.includes(k)) return undefined;
      const v = Number(get(k));
      return Number.isFinite(v) ? v : undefined;
    };
    const row: ProcRow = { pid, cpu: num('pcpu') ?? 0, mem: num('pmem') ?? 0, name: firstWord(args), command: args };
    const ppid = num('ppid');
    if (ppid !== undefined) row.ppid = ppid;
    if (columns.includes('user')) row.user = get('user');
    const rss = num('rss');
    if (rss !== undefined) row.rssBytes = rss * 1024;
    const nlwp = num('nlwp');
    if (nlwp !== undefined) row.threads = nlwp;
    if (columns.includes('etime')) {
      const e = parseEtime(get('etime') ?? '');
      if (e !== undefined) row.elapsedS = e;
    }
    rows.push(row);
  }
  return rows;
}

/** One process of the PowerShell query (short keys keep the JSON small). */
export interface WinProc {
  /** ProcessId */
  p: number;
  /** ParentProcessId */
  pp?: number;
  /** Name */
  n?: string | null;
  /** CommandLine (null when access is denied) */
  c?: string | null;
  /** WorkingSetSize, bytes */
  ws?: number | null;
  /** ThreadCount */
  t?: number | null;
  /** KernelModeTime + UserModeTime are in 100 ns units */
  k?: number | null;
  u?: number | null;
  /** CreationDate as Unix ms (0 when unknown) */
  s?: number | null;
}

/** PowerShell script printing every process as compact JSON (WinProc[]). */
export const WINDOWS_PS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$e = [datetime]'1970-01-01'",
  'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; ws = $_.WorkingSetSize; t = $_.ThreadCount; k = $_.KernelModeTime; u = $_.UserModeTime; s = $(if ($_.CreationDate) { [int64]($_.CreationDate.ToUniversalTime() - $e).TotalMilliseconds } else { 0 }) } } | ConvertTo-Json -Compress'
].join('; ');

/** CPU seconds per pid at a point in time, to turn cumulative CPU into a rate. */
export type CpuSample = Map<number, { cpuS: number; atMs: number }>;

/**
 * Rows from the PowerShell JSON. %CPU is the CPU time used since `prev`
 * (the previous refresh) when the pid is in it, else the lifetime average —
 * both in percent of one core, like ps. Returns the sample for the next call.
 */
export function parseWindowsProcesses(json: string, nowMs: number, totalMem: number, prev?: CpuSample): { rows: ProcRow[]; sample: CpuSample } {
  let data: unknown;
  try {
    // Compact JSON has no raw control characters; stray ones come from odd command lines.
    data = JSON.parse(json.trim().replace(/[\u0000-\u001f]+/g, ' ') || '[]');
  } catch {
    throw new Error('cannot parse the process list from PowerShell');
  }
  const list = (Array.isArray(data) ? data : [data]) as WinProc[];
  const sample: CpuSample = new Map();
  const rows: ProcRow[] = [];
  for (const w of list) {
    if (!w || typeof w.p !== 'number') continue;
    const cpuS = ((w.k ?? 0) + (w.u ?? 0)) / 1e7;
    sample.set(w.p, { cpuS, atMs: nowMs });
    const before = prev?.get(w.p);
    let cpu = 0;
    if (before && nowMs > before.atMs) {
      cpu = Math.max(0, (100 * (cpuS - before.cpuS)) / ((nowMs - before.atMs) / 1000));
    } else if (w.s && nowMs > w.s) {
      cpu = (100 * cpuS) / ((nowMs - w.s) / 1000);
    }
    const name = w.n ?? '';
    const row: ProcRow = {
      pid: w.p,
      cpu: Math.round(cpu * 10) / 10,
      mem: totalMem > 0 && w.ws ? Math.round((1000 * w.ws) / totalMem) / 10 : 0,
      name,
      command: w.c ?? name
    };
    if (typeof w.pp === 'number') row.ppid = w.pp;
    if (typeof w.ws === 'number') row.rssBytes = w.ws;
    if (typeof w.t === 'number') row.threads = w.t;
    if (w.s && nowMs > w.s) row.elapsedS = Math.round((nowMs - w.s) / 1000);
    rows.push(row);
  }
  return { rows, sample };
}

/** Pattern from the setting, falling back to the default when it does not compile. */
export function compilePattern(source: string | undefined): { re: RegExp; source: string; error?: string } {
  const src = (source ?? '').trim() || DEFAULT_PROCESS_PATTERN;
  try {
    return { re: new RegExp(src, 'i'), source: src };
  } catch (e) {
    return { re: new RegExp(DEFAULT_PROCESS_PATTERN, 'i'), source: DEFAULT_PROCESS_PATTERN, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Matching rows without our own helpers, sorted by %CPU (descending). */
export function filterProcesses(rows: ProcRow[], re: RegExp, excludePids: Set<number>): ProcRow[] {
  return rows
    .filter(r => !excludePids.has(r.pid) && !(r.ppid !== undefined && excludePids.has(r.ppid) && /^(ps|conhost\.exe)$/i.test(r.name)))
    .filter(r => re.test(`${r.name} ${r.command}`))
    .sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
}

/** squeue format used by the host; fields separated by '|'. */
export const SQUEUE_FORMAT = '%i|%j|%T|%M|%l|%D|%R';

export function parseSqueue(text: string): QueueJob[] {
  const jobs: QueueJob[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^JOBID\|/i.test(line)) continue;
    const f = line.split('|');
    if (f.length < 7) continue;
    jobs.push({ jobid: f[0].trim(), name: f[1].trim(), state: f[2].trim(), time: f[3].trim(), timeLimit: f[4].trim(), nodes: f[5].trim(), reason: f.slice(6).join('|').trim() });
  }
  return jobs;
}

/** MemAvailable from /proc/meminfo in bytes (Linux), else undefined. */
export function parseMemAvailable(meminfo: string): number | undefined {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : undefined;
}

/** Overall CPU utilization (0–100) between two os.cpus() snapshots. */
export function cpuUtilization(a: { times: Record<string, number> }[], b: { times: Record<string, number> }[]): number {
  let idle = 0;
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const ta = a[i].times;
    const tb = b[i].times;
    const sum = (t: Record<string, number>) => Object.values(t).reduce((x, y) => x + y, 0);
    total += sum(tb) - sum(ta);
    idle += (tb.idle ?? 0) - (ta.idle ?? 0);
  }
  return total > 0 ? Math.max(0, Math.min(100, (100 * (total - idle)) / total)) : 0;
}

/** The last `n` lines of `text` (a trailing newline does not count as an empty line). */
export function lastLines(text: string, n: number): { text: string; lines: number; cut: boolean } {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body === '') return { text: '', lines: 0, cut: false };
  const all = body.split('\n');
  const keep = all.slice(-n);
  return { text: keep.join('\n'), lines: keep.length, cut: all.length > n };
}
