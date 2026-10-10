import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { createRunsHost, readTail } from '../../src/studio/tabs/runs/host';
import {
  DEFAULT_PROCESS_PATTERN, compilePattern, cpuUtilization, filterProcesses, lastLines, parseEtime, parseMemAvailable, parsePs, parseSqueue,
  parseWindowsProcesses
} from '../../src/studio/tabs/runs/procs';
import type { LogsResult, TailResult } from '../../src/studio/tabs/runs/types';
import { globToRegExp, matchesAny } from '../../src/studio/tabs/runs/glob';

// Captured `ps -eww -o pid,ppid,user:32,pcpu,pmem,rss,nlwp,etime,args --sort=-pcpu` (procps, Linux).
const LINUX_PS = `    PID    PPID USER                             %CPU %MEM   RSS NLWP     ELAPSED COMMAND
  48211   48190 tomanl                            795  5.1 1671940    8  1-02:03:04 python3 /disk2/tomanl/uv-vis/scripts/run_adc.py --dir n5000/gle geom_0042
  48190       1 tomanl                            0.0  0.0  3412    1  1-02:03:05 /bin/bash ./run_chain.sh
  51002   51000 tomanl                           99.5  0.6 204800    1       05:06 /opt/orca_6_0_1/orca_scf_mpi ci_opt.scfgbw
  51000   50999 tomanl                            0.1  0.0 10240    3       05:07 /opt/orca_6_0_1/orca ci_opt.inp
   1200       1 root                              0.0  0.0  7168    1  12-00:00:01 /usr/sbin/sshd -D
   9001    8999 tomanl                            0.0  0.0  2048    1       00:00 vim orca.inp
`;

// Captured `ps -axww -o pid,ppid,user,pcpu,pmem,rss,etime,args` (macOS: no nlwp, no --sort).
const MAC_PS = `  PID  PPID USER     %CPU %MEM    RSS ELAPSED COMMAND
  501     1 alice     0.0  0.1   4096   01:02 /usr/libexec/logd
  777   500 alice    98.0  1.2  51200 02:01:02 /Applications/orca/orca input.inp
`;

// Captured PowerShell output (WINDOWS_PS_SCRIPT), trimmed; one command line carries a stray control character.
const WIN_JSON = '[{"p":0,"pp":0,"n":"System Idle Process","c":null,"ws":8192,"t":20,"k":0,"u":0,"s":0},'
  + '{"p":4242,"pp":100,"n":"orca.exe","c":"C:\\\\ORCA\\\\orca.exe job.inp","ws":104857600,"t":4,"k":50000000,"u":550000000,"s":1000000},'
  + '{"p":5151,"pp":100,"n":"python.exe","c":"python.exe C:\\\\work\\\\ml_worker.py \u0007--port 1","ws":2097152,"t":2,"k":0,"u":10000000,"s":1060000}]';

describe('studio runs: parsers', () => {
  it('parses ps etime', () => {
    assert.strictEqual(parseEtime('05:06'), 306);
    assert.strictEqual(parseEtime('10:00:00'), 36000);
    assert.strictEqual(parseEtime('1-02:03:04'), 93784);
    assert.strictEqual(parseEtime('bogus'), undefined);
  });

  it('parses Linux procps output', () => {
    const rows = parsePs(LINUX_PS, ['pid', 'ppid', 'user', 'pcpu', 'pmem', 'rss', 'nlwp', 'etime', 'args']);
    assert.strictEqual(rows.length, 6);
    const adc = rows[0];
    assert.deepStrictEqual([adc.pid, adc.ppid, adc.user, adc.cpu, adc.mem, adc.rssBytes, adc.threads, adc.elapsedS],
      [48211, 48190, 'tomanl', 795, 5.1, 1671940 * 1024, 8, 93784]);
    assert.strictEqual(adc.command, 'python3 /disk2/tomanl/uv-vis/scripts/run_adc.py --dir n5000/gle geom_0042');
    assert.strictEqual(adc.name, 'python3');
    assert.strictEqual(rows[2].name, 'orca_scf_mpi');
  });

  it('parses macOS ps output without nlwp', () => {
    const rows = parsePs(MAC_PS, ['pid', 'ppid', 'user', 'pcpu', 'pmem', 'rss', 'etime', 'args']);
    assert.deepStrictEqual(rows.map(r => [r.pid, r.threads, r.elapsedS, r.name]), [[501, undefined, 62, 'logd'], [777, undefined, 7262, 'orca']]);
  });

  it('parses the PowerShell process JSON with CPU from lifetime, then from deltas', () => {
    const now = 11000000;
    const first = parseWindowsProcesses(WIN_JSON, now, 1024 * 1024 * 1024);
    const orca = first.rows.find(r => r.pid === 4242)!;
    // 60 s of CPU over 10 000 s of life = 0.6 % of one core.
    assert.strictEqual(orca.cpu, 0.6);
    assert.strictEqual(orca.mem, 9.8);
    assert.deepStrictEqual([orca.threads, orca.rssBytes, orca.elapsedS, orca.name, orca.ppid], [4, 104857600, 10000, 'orca.exe', 100]);
    assert.ok(first.rows.find(r => r.pid === 5151)!.command.includes('ml_worker.py  --port'), 'control characters become spaces');
    // 5 s later orca used 4 more CPU seconds: 80 % of one core.
    const later = WIN_JSON.replace('"u":550000000', '"u":590000000');
    const second = parseWindowsProcesses(later, now + 5000, 1024 * 1024 * 1024, first.sample);
    assert.strictEqual(second.rows.find(r => r.pid === 4242)!.cpu, 80);
    assert.throws(() => parseWindowsProcesses('not json', now, 1), /cannot parse/);
    assert.strictEqual(parseWindowsProcesses('{"p":1,"n":"x"}', now, 1).rows.length, 1, 'a single object is accepted');
  });

  it('default pattern picks calculations, not editors or VS Code', () => {
    const re = compilePattern(undefined).re;
    const yes = [
      'orca /opt/orca/orca job.inp', 'orca_scf_mpi /opt/orca/orca_scf_mpi x.scfgbw', 'orca.exe C:\\ORCA\\orca.exe job.inp',
      'python3 python3 /x/scripts/run_adc.py', 'python python -m pyscf.tools', 'python3.11 /usr/bin/python3.11 ml_worker.py --port 0',
      'python.exe "C:\\Python312\\python.exe" from_ensemble.py', 'mpirun mpirun -np 8 orca_scf_mpi', 'srun srun --ntasks 4 xtb mol.xyz',
      'xtb xtb mol.xyz --opt', 'crest crest mol.xyz', 'g16 g16 < job.gjf', 'psi4 psi4 input.dat', 'cp2k.psmp cp2k.psmp -i in.inp',
      'python3 python3 compare_ensembles.py'
    ];
    const no = [
      'vim vim orca.inp', 'code /usr/share/code/code --type=renderer', 'node node /home/u/.vscode-server/extensions/alestoman5.orbital-0.1.0/out/extension.js',
      'bash /bin/bash ./run_chain.sh', 'python3 python3 -m http.server', 'sshd /usr/sbin/sshd -D'
    ];
    for (const s of yes) assert.ok(re.test(s), `should match: ${s}`);
    for (const s of no) assert.ok(!re.test(s), `should not match: ${s}`);
  });

  it('falls back to the default pattern when the setting does not compile', () => {
    const p = compilePattern('orca(');
    assert.ok(p.error);
    assert.strictEqual(p.source, DEFAULT_PROCESS_PATTERN);
    assert.strictEqual(compilePattern('  ').source, DEFAULT_PROCESS_PATTERN);
    assert.strictEqual(compilePattern('xtb').source, 'xtb');
  });

  it('filters processes, drops own helpers, sorts by CPU', () => {
    const rows = parsePs(LINUX_PS, ['pid', 'ppid', 'user', 'pcpu', 'pmem', 'rss', 'nlwp', 'etime', 'args']);
    const kept = filterProcesses(rows, compilePattern(undefined).re, new Set([51000]));
    assert.deepStrictEqual(kept.map(r => r.pid), [48211, 51002]);
  });

  it('parses squeue output', () => {
    const jobs = parseSqueue('1234|nea_gle|RUNNING|1:02:03|2-00:00:00|1|node017\n1235|nea|PENDING|0:00|1-00:00:00|2|(Priority)\n\n');
    assert.deepStrictEqual(jobs.map(j => [j.jobid, j.state, j.reason]), [['1234', 'RUNNING', 'node017'], ['1235', 'PENDING', '(Priority)']]);
    assert.strictEqual(jobs[0].time, '1:02:03');
    assert.deepStrictEqual(parseSqueue(''), []);
  });

  it('parses MemAvailable and CPU utilization', () => {
    assert.strictEqual(parseMemAvailable('MemTotal: 100 kB\nMemFree:  10 kB\nMemAvailable:   40 kB\n'), 40 * 1024);
    assert.strictEqual(parseMemAvailable('nothing'), undefined);
    const a = [{ times: { user: 100, nice: 0, sys: 0, idle: 900, irq: 0 } }];
    const b = [{ times: { user: 400, nice: 0, sys: 100, idle: 1400, irq: 0 } }];
    assert.strictEqual(cpuUtilization(a, b), 400 / 9);
    assert.strictEqual(cpuUtilization(a, a), 0);
  });

  it('keeps the last lines of a text', () => {
    assert.deepStrictEqual(lastLines('a\nb\nc\n', 2), { text: 'b\nc', lines: 2, cut: true });
    assert.deepStrictEqual(lastLines('a\nb', 5), { text: 'a\nb', lines: 2, cut: false });
    assert.deepStrictEqual(lastLines('', 5), { text: '', lines: 0, cut: false });
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function fakeContext(root: string, settings: Record<string, unknown> = {}): HostContext & { excludes: (string | undefined)[] } {
  const excludes: (string | undefined)[] = [];
  return {
    excludes,
    tab: 'runs',
    extensionPath: '.',
    workspaceFolders: () => [root],
    storageDir: () => undefined,
    config: <T>(k: string, fallback: T) => (k in settings ? (settings[k] as T) : fallback),
    async findFiles(include, options = {}) {
      excludes.push(options.exclude);
      const base = options.base ?? root;
      const rel = (f: string) => path.relative(base, f).split(path.sep).join('/');
      const re = globToRegExp(include);
      return walk(base).filter(f => re.test(rel(f)) && !(options.exclude && matchesAny(rel(f), [options.exclude])));
    },
    watch: () => ({ dispose() {} }),
    post: () => undefined,
    navigate: () => undefined,
    saveFile: async () => undefined,
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    log: () => undefined
  };
}

describe('studio runs host: logs and tail', () => {
  let tmp: string;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-runs-'));
    fs.mkdirSync(path.join(tmp, 'ens', 'geom_0001'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'md'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ens', 'pipeline.log'), 'one\ntwo\n');
    fs.writeFileSync(path.join(tmp, 'ens', 'geom_0001', 'run.log'), 'geometry log\n');
    fs.writeFileSync(path.join(tmp, 'md', 'output'), 'step 1\n');
    fs.writeFileSync(path.join(tmp, 'job.out'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n');
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(tmp, 'md', 'output'), t - 100, t - 100);
    fs.utimesSync(path.join(tmp, 'ens', 'pipeline.log'), t - 50, t - 50);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('lists logs newest first without geom_* directories', async () => {
    const ctx = fakeContext(tmp);
    const r = (await createRunsHost().methods.logs({}, ctx)) as LogsResult;
    assert.deepStrictEqual(r.files.map(f => f.rel), ['job.out', 'ens/pipeline.log', 'md/output']);
    assert.strictEqual(r.total, 3);
    assert.ok(ctx.excludes.every(e => e === '{**/node_modules/**,**/.git/**,**/geom_*/**}'));
  });

  it('honours logGlobs and logExcludeGlobs settings', async () => {
    const ctx = fakeContext(tmp, { 'studio.logGlobs': ['**/*.log'], 'studio.logExcludeGlobs': [] });
    const r = (await createRunsHost().methods.logs({}, ctx)) as LogsResult;
    assert.deepStrictEqual(r.files.map(f => f.rel).sort(), ['ens/geom_0001/run.log', 'ens/pipeline.log']);
  });

  it('tails the last lines and reports unchanged files', async () => {
    const host = createRunsHost();
    const ctx = fakeContext(tmp);
    const file = path.join(tmp, 'job.out');
    const t = (await host.methods.tail({ path: file, lines: 3 }, ctx)) as TailResult;
    assert.deepStrictEqual([t.text, t.lines, t.more], ['line 998\nline 999\nline 1000', 3, true]);
    const same = (await host.methods.tail({ path: file, lines: 3, since: { size: t.size, mtimeMs: t.mtimeMs } }, ctx)) as TailResult;
    assert.strictEqual(same.unchanged, true);
    const all = (await host.methods.tail({ path: file, lines: 5000 }, ctx)) as TailResult;
    assert.deepStrictEqual([all.lines, all.more], [1000, false]);
    fs.appendFileSync(file, 'line 1001\n');
    const grown = (await host.methods.tail({ path: file, lines: 1, since: { size: t.size, mtimeMs: t.mtimeMs } }, ctx)) as TailResult;
    assert.deepStrictEqual([grown.unchanged, grown.text], [undefined, 'line 1001']);
  });

  it('reads long tails across block boundaries', () => {
    const file = path.join(tmp, 'big.log');
    const line = 'x'.repeat(99);
    fs.writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `${i}:${line}`).join('\n'));
    const t = readTail(file, 2000);
    const lines = t.text.split('\n');
    assert.strictEqual(lines.length, 2000);
    assert.strictEqual(lines[0], `1000:${line}`);
    assert.strictEqual(lines[1999], `2999:${line}`);
  });

  it('refuses paths outside the workspace and bad pids', async () => {
    const host = createRunsHost();
    const ctx = fakeContext(tmp);
    assert.throws(() => host.methods.tail({ path: path.join(os.tmpdir(), 'x.log') }, ctx), /outside the workspace/);
    assert.throws(() => host.methods.tail({ path: path.join(tmp, 'missing.log') }, ctx), /does not exist/);
    await assert.rejects(async () => host.methods.kill({ pid: 1 }, ctx), /refusing/);
    await assert.rejects(async () => host.methods.kill({ pid: process.pid }, ctx), /refusing/);
    await assert.rejects(async () => host.methods.kill({ pid: 'abc' }, ctx), /refusing/);
  });

  it('does not signal a process that the pattern does not list', async function () {
    this.timeout(20000);
    const host = createRunsHost();
    const ctx = fakeContext(tmp, { 'studio.processPattern': 'no-such-program-xyz' });
    const r = (await host.methods.kill({ pid: process.ppid > 1 ? process.ppid + 1 : 999999 }, ctx)) as { ok: boolean; message: string };
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /no longer running/);
  });

  it('lists processes on this machine', async function () {
    this.timeout(20000);
    const ctx = fakeContext(tmp, { 'studio.processPattern': 'node' });
    const r = (await createRunsHost().methods.processes({}, ctx)) as { rows: { pid: number }[]; scanned: number; error?: string };
    assert.strictEqual(r.error, undefined);
    assert.ok(r.scanned > 1);
    assert.ok(!r.rows.some(p => p.pid === process.pid), 'own process excluded');
  });
});
