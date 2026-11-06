import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { host, inWorkdir, projectDetail, projectSummary, readStages, saveProject } from '../../src/studio/tabs/accel/host';
import { defaultForm } from '../../src/accel/spec';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'accel', 'h2co');

function fakeContext(ws: string, log: string[] = []): HostContext {
  return {
    tab: 'accel', extensionPath: '.',
    workspaceFolders: () => [ws], storageDir: () => undefined,
    config: (_k, fallback) => fallback,
    findFiles: async () => [],
    watch: () => ({ dispose() {} }),
    post: () => undefined,
    navigate: (tab, args) => log.push(`navigate ${tab} ${JSON.stringify(args)}`),
    saveFile: async () => undefined, openFile: async p => { log.push(`open ${p.path}`); },
    pickFiles: async () => [], confirm: async () => true, notify: () => undefined,
    runInTerminal: p => log.push(`terminal ${p.command}`), activeEditorPath: () => undefined,
    log: m => log.push(m)
  };
}

describe('accel host', () => {
  it('reads the stage states (missing stages are pending)', () => {
    const { stages, pid } = readStages(FIXTURE);
    assert.strictEqual(stages.optfreq.status, 'done');
    assert.strictEqual(stages.spectrum.status, 'done');
    assert.strictEqual(pid, 999999);
    assert.strictEqual(readStages(os.tmpdir()).stages.train.status, 'pending');
  });

  it('collects the project detail from the stage outputs', async () => {
    const d = await projectDetail(FIXTURE);
    assert.strictEqual(d.running, false);
    assert.strictEqual(d.interrupted, false);
    assert.strictEqual(d.form.geometry, path.join(FIXTURE, 'h2co.xyz'));
    assert.strictEqual(d.freqs?.n_imag, 0);
    assert.strictEqual(d.minimum?.target_state, 2);
    assert.strictEqual(d.minimum?.states[0].character, 'n -> pi*');
    assert.deepStrictEqual(d.excite, { total: 60, done: 2, converged: 1, failed: 1, nstates: null });
    assert.ok(d.mbtr && d.mbtr.min < d.mbtr.data_min);
    assert.strictEqual(d.krr?.n_all, 3000);
    assert.deepStrictEqual(d.spectrum.map(s => s.kind), ['ml', 'direct']);
    const ml = d.spectrum[0];
    assert.ok(ml.x.length > 10 && ml.lo && ml.hi && ml.x.every((v, i) => i === 0 || v >= ml.x[i - 1]));
  });

  it('summarises a project for the list', async () => {
    const s = await projectSummary(FIXTURE);
    assert.strictEqual(s?.name, 'h2co');
    assert.strictEqual(s?.sampling, 'Wigner');
    assert.strictEqual(s?.method, 'adc(2)/6-31g');
  });

  it('keeps file access inside the work directory', () => {
    assert.strictEqual(inWorkdir('/w', '02-minimum/cubes/mo_9.cube'), path.resolve('/w/02-minimum/cubes/mo_9.cube'));
    assert.throws(() => inWorkdir('/w', '../etc/passwd'), /not inside/);
  });

  it('writes accel.json with paths relative to the work directory', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'accel-'));
    try {
      fs.writeFileSync(path.join(ws, 'm.xyz'), '2\n\nH 0 0 0\nH 0 0 0.74\n');
      const ctx = fakeContext(ws);
      const bad = saveProject(ctx, { ...defaultForm(), workdir: 'runs/m', geometry: path.join(ws, 'missing.xyz') });
      assert.strictEqual(bad.ok, false);
      assert.ok(bad.errors.some(e => e.field === 'geometry'));
      const r = saveProject(ctx, { ...defaultForm(), workdir: 'runs/m', geometry: path.join(ws, 'm.xyz'), name: 'm' });
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.strictEqual(r.workdir, path.join(ws, 'runs', 'm'));
      const cfg = JSON.parse(fs.readFileSync(path.join(ws, 'runs', 'm', 'accel.json'), 'utf8'));
      assert.strictEqual(cfg.geometry, path.join(ws, 'm.xyz'));   // outside the work directory: absolute
      assert.strictEqual(cfg.name, 'm');
      const outside = saveProject(ctx, { ...defaultForm(), workdir: '/definitely/outside', geometry: path.join(ws, 'm.xyz') });
      assert.strictEqual(outside.ok, false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('navigates to the viewer and refuses missing files', async () => {
    const log: string[] = [];
    const ctx = fakeContext(path.dirname(FIXTURE), log);
    host.methods.show({ workdir: FIXTURE, file: '01-optfreq/opt.xyz' }, ctx);
    host.methods.show({ workdir: FIXTURE, file: '06-spectrum/spectrum.json', tab: 'spectra' }, ctx);
    assert.match(log[0], /^navigate viewer .*opt\.xyz/);
    assert.match(log[1], /^navigate spectra /);
    assert.throws(() => host.methods.show({ workdir: FIXTURE, file: '02-minimum/cubes/mo_9.cube' }, ctx), /does not exist/);
  });

  it('refuses to run without the uv-vis scripts', async () => {
    const ctx = fakeContext(path.dirname(FIXTURE));
    await assert.rejects(Promise.resolve(host.methods.run({ workdir: FIXTURE }, ctx)), /accelerated\.py not found/);
  });
});
