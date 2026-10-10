import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { configToForm, host, readCsvHeader, splitCsvLine, thinPredictions } from '../../src/studio/tabs/ml/host';
import { buildConfig, defaultForm } from '../../src/ml/spec';
import type { CsvHeader, EnvCheck, MlForm, RunDetail, RunSummary, StartResult } from '../../src/studio/tabs/ml/types';

const FIX = path.join(__dirname, '../fixtures/ml');
const PYTHON = process.env.ORBITAL_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const HAVE_PYTHON = spawnSync(PYTHON, ['--version']).status === 0;

interface Fake {
  ctx: HostContext;
  ws: string;
  log: string[];
  saved: { defaultName: string; data: string }[];
  settings: Record<string, unknown>;
}

/** Workspace in a temp folder, extension folder whose python/ml_worker.py is the fake worker. */
const made: string[] = [];
after(() => made.forEach(d => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 })));

function fake(settings: Record<string, unknown> = {}): Fake {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-mlhost-'));
  made.push(ws);
  const ext = path.join(ws, '_ext');
  fs.mkdirSync(path.join(ext, 'python'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'fake_worker.py'), path.join(ext, 'python', 'ml_worker.py'));
  const log: string[] = [];
  const saved: { defaultName: string; data: string }[] = [];
  const all = { 'studio.pythonPath': PYTHON, ...settings };
  const ctx: HostContext = {
    tab: 'ml',
    extensionPath: ext,
    workspaceFolders: () => [ws],
    storageDir: () => {
      const d = path.join(ws, '.orbital');
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    config: <T>(k: string, fallback: T) => (k in all ? (all as any)[k] : fallback),
    findFiles: async () => [],
    watch: () => ({ dispose() {} }),
    post: () => undefined,
    navigate: () => undefined,
    saveFile: async p => {
      saved.push({ defaultName: p.defaultName, data: p.data });
      return path.join(ws, p.defaultName);
    },
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    log: m => log.push(m)
  };
  return { ctx, ws, log, saved, settings: all };
}

const call = <T>(f: Fake, method: string, params?: unknown) => Promise.resolve().then(() => host.methods[method](params, f.ctx)) as Promise<T>;

function dataset(ws: string): { xyz: string; csv: string; feats: string } {
  const xyz = path.join(ws, 'mols.xyz');
  const csv = path.join(ws, 'targets.csv');
  const feats = path.join(ws, 'X.csv');
  fs.writeFileSync(xyz, '1\nH\nH 0 0 0\n'.repeat(5));
  fs.writeFileSync(csv, 'id,E,"gap, eV"\n0,1.5,2\n1,2.5,3\n2,3.5,4\n\n');
  fs.writeFileSync(feats, '1,2\n3,4\n5,6\n');
  return { xyz, csv, feats };
}

function copyFixtureRuns(f: Fake): string {
  const dir = path.join(f.ws, '.orbital', 'ml_runs');
  fs.cpSync(path.join(FIX, 'runs'), dir, { recursive: true });
  return dir;
}

async function until(cond: () => boolean, ms = 20000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 50));
  }
}

describe('studio ml host: helpers', () => {
  it('splits CSV lines with quotes', () => {
    assert.deepStrictEqual(splitCsvLine('a, "b,c" ,"d""e",'), ['a', 'b,c', 'd"e', '']);
  });

  it('turns a config back into a form that rebuilds the same config', () => {
    const form: MlForm = defaultForm('precomputed', 'KRR');
    form.name = 'grid';
    form.data.csv = '/d/y.csv';
    form.data.n_mol = '50';
    form.rep.params = { path: '/d/X.npy' };
    form.model.grid = true;
    form.model.params = { kernel: 'rbf', alpha: 'log:-6,-2,5', gamma: '1e-3,1e-2' };
    form.split.curve = '10, 20';
    const a = buildConfig(form);
    assert.ok(a.config, JSON.stringify(a.errors));
    const back = configToForm(a.config!);
    assert.strictEqual(back.name, 'grid (copy)');
    assert.strictEqual(back.model.params!.gamma, '0.001,0.01');
    const b = buildConfig({ ...back, name: 'grid' });
    assert.deepStrictEqual(b.config, a.config);
  });

  it('thins predictions with one stride per set', () => {
    const y = Array.from({ length: 10 }, (_, i) => i);
    const t = thinPredictions({ y_train: y, y_train_pred: y, y_test: [1, 2], y_test_pred: [3, 4] }, 4)!;
    assert.deepStrictEqual(t.y_train, [0, 3, 6, 9]);
    assert.deepStrictEqual(t.y_train_pred, [0, 3, 6, 9]);
    assert.deepStrictEqual(t.y_test, [1, 2]);
  });
});

describe('studio ml host: methods', () => {
  it('init reports settings and the runs folder', async () => {
    const f = fake({ 'studio.ml.maxJobs': 4 });
    const r = await call<any>(f, 'init');
    assert.strictEqual(r.maxJobs, 4);
    assert.strictEqual(r.hasStorage, true);
    assert.strictEqual(r.runsDir, path.join(f.ws, '.orbital', 'ml_runs'));
  });

  it('reads the CSV header (with and without a header row), cached by mtime', async () => {
    const f = fake();
    const { csv } = dataset(f.ws);
    const h = await call<CsvHeader>(f, 'csvHeader', { path: 'targets.csv' });
    assert.deepStrictEqual(h.columns, ['id', 'E', 'gap, eV']);
    assert.strictEqual(h.rows, 3);
    assert.deepStrictEqual(h.numeric, [true, true, true]);
    const n = await call<CsvHeader>(f, 'csvHeader', { path: csv, header: false });
    assert.deepStrictEqual(n.columns, ['column 0', 'column 1', 'column 2']);
    assert.strictEqual(n.rows, 4);
    assert.deepStrictEqual(n.numeric, [false, false, false]);
    assert.strictEqual(readCsvHeader(csv, true), readCsvHeader(csv, true));
  });

  it('rejects paths outside the workspace', async () => {
    const f = fake();
    await assert.rejects(call(f, 'csvHeader', { path: path.join(os.tmpdir(), 'elsewhere.csv') }), /outside the workspace/);
  });

  it('returns field errors instead of creating a run', async () => {
    const f = fake();
    const form = defaultForm('precomputed', 'Ridge');
    form.data.csv = 'missing.csv';
    form.model.params = { alpha: '1,2' };
    const r = await call<StartResult>(f, 'start', { form });
    assert.strictEqual(r.ok, false);
    const fields = (r as any).errors.map((e: any) => e.field).sort();
    assert.deepStrictEqual(fields, ['data.csv', 'model.params.alpha', 'rep.params.path']);
    assert.ok(!fs.existsSync(path.join(f.ws, '.orbital', 'ml_runs')) || fs.readdirSync(path.join(f.ws, '.orbital', 'ml_runs')).length === 0);
  });

  (HAVE_PYTHON ? it : it.skip)('creates and starts a run with the worker, then lists, reads and exports it', async function () {
    this.timeout(30000);
    const f = fake({ 'studio.ml.maxJobs': 2 });
    const { csv, feats } = dataset(f.ws);
    const form = defaultForm('precomputed', 'Ridge');
    form.name = 'e2e';
    form.data.csv = path.relative(f.ws, csv);
    form.data.column = 'E';
    form.rep.params = { path: feats };
    form.n_jobs = '64';
    const r = await call<StartResult>(f, 'start', { form });
    assert.ok(r.ok, JSON.stringify(r));
    const id = (r as any).id as string;
    const cfg = JSON.parse(fs.readFileSync(path.join(f.ws, '.orbital', 'ml_runs', id, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.data.csv, csv);
    assert.strictEqual(cfg.n_jobs, 2);
    assert.strictEqual(cfg.cache_dir, path.join(f.ws, '.orbital', 'ml_cache'));
    await until(() => {
      const runs = host.methods.list(undefined, f.ctx) as RunSummary[];
      return runs[0]?.state === 'done';
    });
    const [s] = await call<RunSummary[]>(f, 'list');
    assert.deepStrictEqual([s.id, s.name, s.rep, s.model, s.test?.mae], [id, 'e2e', 'precomputed', 'Ridge', 0.5]);
    const d = await call<RunDetail>(f, 'read', { id });
    assert.deepStrictEqual(d.pred?.y_test, [5]);
    assert.match(d.log, /fake worker started/);
    const back = await call<MlForm>(f, 'formOf', { id });
    assert.strictEqual(back.data.csv, csv);
    await call(f, 'exportCsv');
    assert.strictEqual(f.saved[0].defaultName, 'ml_runs.csv');
    assert.match(f.saved[0].data, new RegExp(`^run,name,.*\\n${id},e2e,`, 's'));
    await call(f, 'exportPredictions', { id });
    assert.strictEqual(f.saved[1].data, 'reference,predicted\n5,5.5\n');
    await call(f, 'remove', { id });
    assert.deepStrictEqual(await call(f, 'list'), []);
  });

  it('lists and reads fixture runs, and compares them', async () => {
    const f = fake();
    copyFixtureRuns(f);
    const list = await call<RunSummary[]>(f, 'list');
    assert.deepStrictEqual(list.map(r => r.id), ['20260104-070000', '20260103-080000', '20260102-090000', '20260101-120000']);
    assert.strictEqual(list.find(r => r.id === '20260103-080000')!.state, 'failed');   // pid is dead
    const d = await call<RunDetail>(f, 'read', { id: '20260101-120000' });
    assert.strictEqual(d.result?.test.mae, 0.2);
    const cmp = await call<any[]>(f, 'compare', { ids: ['20260101-120000', '20260104-070000'] });
    assert.deepStrictEqual(cmp.map(c => [c.name, c.test?.mae ?? null, c.curve.length]), [['finished grid', 0.2, 2], [cmp[1].name, null, 0]]);
    await assert.rejects(call(f, 'read', { id: '../x' }), /invalid run id/);
  });

  it('list is empty without a workspace', async () => {
    const f = fake();
    f.ctx.storageDir = () => undefined;
    assert.deepStrictEqual(await call(f, 'list'), []);
    await assert.rejects(call(f, 'read', { id: 'x' }), /open a workspace folder/);
  });

  (HAVE_PYTHON ? it : it.skip)('checks the environment with the configured python (cached until refresh)', async function () {
    this.timeout(30000);
    const f = fake();
    const a = await call<EnvCheck>(f, 'checkEnv');
    assert.deepStrictEqual([a.ok, a.python, a.missing_required], [false, '3.99.0', ['sklearn']]);
    assert.strictEqual(a.packages.numpy, '2.0');
    assert.strictEqual(await call<EnvCheck>(f, 'checkEnv'), a);
    const b = await call<EnvCheck>(f, 'checkEnv', { refresh: true });
    assert.notStrictEqual(b, a);
  });

  it('reports a missing interpreter cleanly', async function () {
    this.timeout(30000);
    const f = fake({ 'studio.pythonPath': 'definitely-not-a-python-xyz' });
    const r = await call<EnvCheck>(f, 'checkEnv', { refresh: true });
    assert.strictEqual(r.ok, false);
    assert.match(r.error ?? '', /not found|failed/);
  });
});
