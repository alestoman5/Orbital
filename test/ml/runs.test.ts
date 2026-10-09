import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkEnvironment,
  createRun,
  deleteRun,
  isValidRunId,
  listRuns,
  newRunId,
  predictionsCsv,
  readRun,
  readStatus,
  runDirOf,
  runsCsv,
  startRun,
  stopRun
} from '../../src/ml/runs';
import { isAlive } from '../../src/ml/proc';
import type { MlConfig } from '../../src/ml/spec';

const FIX = path.join(__dirname, '../fixtures/ml');
const FAKE = path.join(FIX, 'fake_worker.py');
const PYTHON = process.env.ORBITAL_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const HAVE_PYTHON = spawnSync(PYTHON, ['--version']).status === 0;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-ml-'));
}

function copyRuns(): string {
  const dir = tmpDir();
  fs.cpSync(path.join(FIX, 'runs'), dir, { recursive: true });
  return dir;
}

async function until(cond: () => boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 50));
  }
}

const CONFIG = {
  schema: 1, name: 'test', data: { xyz: '/d/m.xyz', csv: '/d/y.csv', column: 'E', header: true, n_mol: null },
  rep: { name: 'CM', params: {}, variance: true, scale: true },
  model: { name: 'KRR', grid: false, params: {} },
  split: { test_size: 0.2, seed: 42, cv: 5, curve: [] }, n_jobs: 1, cache_dir: null
} as unknown as MlConfig;

describe('ml/runs: ids', () => {
  it('formats ids as YYYYMMDD-HHMMSS', () => {
    assert.strictEqual(newRunId(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
  });

  it('rejects ids that could escape runsDir', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '', '.', 'C:', 'a.b', ' a', 'x'.repeat(101), 5, null, undefined]) {
      assert.strictEqual(isValidRunId(bad), false, String(bad));
      assert.throws(() => runDirOf('/runs', bad), /invalid run id/);
    }
    assert.strictEqual(runDirOf(path.resolve('/runs'), 'abc_1-2'), path.resolve('/runs', 'abc_1-2'));
  });

  it('createRun avoids collisions', () => {
    const dir = tmpDir();
    const now = new Date(2026, 4, 6, 7, 8, 9);
    const a = createRun(dir, CONFIG, now);
    const b = createRun(dir, CONFIG, now);
    assert.deepStrictEqual([a.id, b.id], ['20260506-070809', '20260506-070809-2']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(a.dir, 'config.json'), 'utf8')), CONFIG);
    assert.strictEqual(readStatus(a.dir).state, 'created');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ml/runs: listing and reading fixture runs', () => {
  let dir: string;
  before(() => { dir = copyRuns(); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists runs with config, newest first, with metric summaries', () => {
    const runs = listRuns(dir);
    assert.deepStrictEqual(runs.map(r => r.id), ['20260104-070000', '20260103-080000', '20260102-090000', '20260101-120000']);
    const done = runs[3];
    assert.strictEqual(done.state, 'done');
    assert.strictEqual(done.name, 'finished grid');
    assert.strictEqual(done.target, 'targets.csv:E');
    assert.deepStrictEqual([done.rep, done.model, done.grid], ['MBTR', 'KRR', true]);
    assert.deepStrictEqual([done.n_train, done.n_test, done.n_features, done.cv_mae], [80, 20, 150, 0.21]);
    assert.deepStrictEqual(done.test, { mae: 0.2, rmse: 0.3, r2: 0.95 });
    assert.strictEqual(done.hasCurve, true);
    assert.strictEqual(runs[2].state, 'failed');
    assert.match(runs[2].error!, /dscribe/);
    assert.deepStrictEqual([runs[1].state, runs[1].step], ['failed', 'process died']);   // stale pid
    assert.deepStrictEqual([runs[0].state, runs[0].test], ['created', null]);
  });

  it('reads one run with prediction lists and the log tail', () => {
    const r = readRun(dir, '20260101-120000', { logLines: 2 });
    assert.strictEqual(r.config.rep.name, 'MBTR');
    assert.strictEqual(r.result!.curve!.length, 2);
    assert.deepStrictEqual(r.pred!.y_test_pred, [null]);
    assert.strictEqual(r.log, 'line 2\nline 3');
    assert.throws(() => readRun(dir, 'no-config'), /run not found/);
    assert.throws(() => readRun(dir, '../runs'), /invalid run id/);
  });

  it('exports CSV of finished runs and of predictions', () => {
    const csv = runsCsv(dir).trim().split('\n');
    assert.strictEqual(csv.length, 2);
    assert.match(csv[1], /^20260101-120000,finished grid,targets\.csv:E,MBTR,KRR,80,20,150,0\.2,0\.3,0\.95,0\.1,0\.21,1\.5,0\.3,"\{""rep""/);
    assert.strictEqual(predictionsCsv(readRun(dir, '20260101-120000').pred!), 'reference,predicted\n3,\n');
  });

  it('deletes a finished run, refuses invalid ids', async () => {
    await deleteRun(dir, '20260102-090000');
    assert.ok(!fs.existsSync(path.join(dir, '20260102-090000')));
    await assert.rejects(deleteRun(dir, '..'), /invalid run id/);
  });

  it('missing runsDir lists nothing', () => {
    assert.deepStrictEqual(listRuns(path.join(dir, 'nope')), []);
  });
});

(HAVE_PYTHON ? describe : describe.skip)('ml/runs: spawning a (fake) worker', function () {
  this.timeout(60000);
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('checkEnvironment parses the JSON line of --check', async () => {
    const env = await checkEnvironment(PYTHON, FAKE);
    assert.strictEqual(env.python, '3.99.0');
    assert.strictEqual(env.packages.numpy, '2.0');
    assert.strictEqual(env.packages.sklearn, null);
    assert.deepStrictEqual([env.ok, env.missing_required, env.error], [false, ['sklearn'], undefined]);
  });

  it('checkEnvironment reports a missing interpreter, bad output and a timeout', async () => {
    const missing = await checkEnvironment(path.join(dir, 'no-python.exe'), FAKE);
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error!, /python not found|failed/);
    process.env.FAKE_CHECK = 'garbage';
    try {
      assert.match((await checkEnvironment(PYTHON, FAKE)).error!, /failed|parse/);
      process.env.FAKE_CHECK = 'fail';
      assert.match((await checkEnvironment(PYTHON, FAKE)).error!, /something broke/);
      process.env.FAKE_CHECK = 'slow';
      assert.match((await checkEnvironment(PYTHON, FAKE, 1500)).error!, /no answer/);
    } finally {
      delete process.env.FAKE_CHECK;
    }
  });

  it('starts detached, logs stdout and stderr, and finishes', async () => {
    const run = createRun(dir, { ...CONFIG, fake: 'done' } as unknown as MlConfig);
    const pid = await startRun(PYTHON, FAKE, run.dir);
    assert.ok(pid > 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(run.dir, 'spawn.json'), 'utf8')).pid, pid);
    await until(() => readStatus(run.dir).state === 'done');
    await until(() => !isAlive(pid));
    const r = readRun(dir, run.id);
    assert.deepStrictEqual(r.pred!.y_test, [5]);
    assert.match(r.log, /fake worker started/);
    assert.match(r.log, /to stderr/);
    assert.strictEqual(listRuns(dir)[0].test!.mae, 0.5);
    assert.deepStrictEqual(await stopRun(run.dir), { stopped: false, state: 'done' });
  });

  it('stops a running worker and marks the run stopped', async () => {
    const run = createRun(dir, { ...CONFIG, fake: 'sleep' } as unknown as MlConfig);
    const pid = await startRun(PYTHON, FAKE, run.dir);
    await until(() => readStatus(run.dir).state === 'running');
    const workerPid = readStatus(run.dir).pid!;
    assert.ok(isAlive(workerPid));
    await assert.rejects(startRun(PYTHON, FAKE, run.dir), /already running/);
    await assert.rejects(deleteRun(dir, run.id), /stop it first/);
    assert.deepStrictEqual(await stopRun(run.dir), { stopped: true, state: 'stopped' });
    await until(() => !isAlive(workerPid) && !isAlive(pid));
    assert.strictEqual(readStatus(run.dir).state, 'stopped');
  });

  it('a worker that dies without a final status is reported as failed', async () => {
    const run = createRun(dir, { ...CONFIG, fake: 'crash' } as unknown as MlConfig);
    const pid = await startRun(PYTHON, FAKE, run.dir);
    await until(() => !isAlive(pid));
    await until(() => readStatus(run.dir).state === 'failed');
    assert.strictEqual(readStatus(run.dir).step, 'process died');
  });

  it('a missing interpreter rejects and marks the run failed', async () => {
    const run = createRun(dir, CONFIG);
    await assert.rejects(startRun(path.join(dir, 'no-python'), FAKE, run.dir));
    assert.strictEqual(readStatus(run.dir).state, 'failed');
    assert.match(fs.readFileSync(path.join(run.dir, 'log.txt'), 'utf8'), /could not start/);
  });

  it('force-deletes a running run', async () => {
    const run = createRun(dir, { ...CONFIG, fake: 'sleep' } as unknown as MlConfig);
    await startRun(PYTHON, FAKE, run.dir);
    await until(() => readStatus(run.dir).state === 'running');
    await deleteRun(dir, run.id, { force: true });
    assert.ok(!fs.existsSync(run.dir));
  });
});
