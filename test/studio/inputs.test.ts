// Host side of the Input Builder tab (src/studio/tabs/inputs/host.ts), called
// through its methods with a fake HostContext as the panel would.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import type { ConfirmParams, OpenFileParams, SaveFileParams } from '../../src/studio/protocol';
import { host } from '../../src/studio/tabs/inputs/host';
import type {
  BatchPlanResult, LoadedGeometry, NeaCommandResult, NeaInfo, SaveInputResult, WriteBatchResult
} from '../../src/studio/tabs/inputs/types';
import { applyTemplate } from '../../src/inputs/templates';
import { defaultSpec } from '../../src/inputs/spec';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');
const SNAPSHOTS = path.resolve(__dirname, '..', 'inputs', '__snapshots__');

interface Fake extends HostContext {
  saved: SaveFileParams[];
  opened: OpenFileParams[];
  confirms: ConfirmParams[];
  answer: boolean;
  picks: string[];
  settings: Record<string, unknown>;
  found: string[];
}

function fakeContext(folders: string[]): Fake {
  const ctx: Fake = {
    tab: 'inputs',
    extensionPath: '.',
    saved: [], opened: [], confirms: [], answer: true, picks: [], settings: {}, found: [],
    workspaceFolders: () => folders,
    storageDir: () => undefined,
    config: <T>(k: string, fallback: T) => (k in ctx.settings ? ctx.settings[k] as T : fallback),
    findFiles: async () => ctx.found,
    watch: () => ({ dispose() {} }),
    post: () => undefined,
    navigate: () => undefined,
    saveFile: async p => {
      ctx.saved.push(p);
      const target = p.path ?? path.join(folders[0], p.defaultName); // the 'dialog' picks the workspace root
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, p.data);
      return target;
    },
    openFile: async p => { ctx.opened.push(p); },
    pickFiles: async () => ctx.picks,
    confirm: async p => { ctx.confirms.push(p); return ctx.answer; },
    notify: () => undefined,
    log: () => undefined
  };
  return ctx;
}

const call = async <T>(method: string, params: unknown, ctx: HostContext): Promise<T> => (await host.methods[method](params, ctx)) as T;

// Optimization .out in the shape of test/outparser/parse.test.ts (OPT_OUT), with a doublet cation.
const OPT_OUT = `
INPUT FILE
==========
|  1> ! B3LYP def2-SVP Opt
|  2> * xyz 1 2
|  3> O   0.000000   0.000000   0.000000
|  4> H   0.000000   0.760000   0.590000
|  5> H   0.000000  -0.760000   0.590000
|  6> *

CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O      0.000000    0.000000    0.000000
  H      0.000000    0.760000    0.590000
  H      0.000000   -0.760000    0.590000

CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O      0.000000    0.000000    0.010000
  H      0.000000    0.757000    0.586000
  H      0.000000   -0.757000    0.586000

                          THE OPTIMIZATION HAS CONVERGED

****ORCA TERMINATED NORMALLY****
`;

const XYZ2 = '3\nframe a\nO 0 0 0.117\nH 0 0.757 -0.469\nH 0 -0.757 -0.469\n3\nframe b\nO 0 0 0.12\nH 0 0.76 -0.47\nH 0 -0.76 -0.47\n';

describe('inputs tab host', () => {
  let ws: string;
  let ctx: Fake;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-inputs-'));
    ctx = fakeContext([ws, FIXTURES, SNAPSHOTS]);
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  describe('loadGeometry', () => {
    it('reads the first frame and the frame count of a multi-XYZ file', async () => {
      const g = await call<LoadedGeometry>('loadGeometry', { path: path.join(FIXTURES, 'xyz', 'three.xyz') }, ctx);
      assert.strictEqual(g.kind, 'xyz');
      assert.strictEqual(g.frames, 3);
      assert.deepStrictEqual(g.atoms.map(a => a.symbol), ['C', 'O', 'O', 'H', 'H']);
      assert.strictEqual(g.atoms[1].x, 1.27);
      assert.strictEqual(g.comment, 'frame 1 ICOND 1');
      assert.strictEqual(g.xyzPath, path.join(FIXTURES, 'xyz', 'three.xyz'));
    });

    it('reads the inline coordinate block of an .inp with charge and multiplicity', async () => {
      const g = await call<LoadedGeometry>('loadGeometry', { path: path.join(SNAPSHOTS, 'eom-ccsd.orca.inp') }, ctx);
      assert.strictEqual(g.kind, 'inp');
      assert.ok(g.atoms.length > 0);
      assert.strictEqual(g.charge, 0);
      assert.strictEqual(g.multiplicity, 1);
      assert.ok(g.atoms.every(a => !('line' in a)), 'line numbers are not sent to the webview');
    });

    it('follows "* xyzfile" of an .inp to the referenced geometry', async () => {
      fs.writeFileSync(path.join(ws, 'mol.xyz'), '2\n\nN 0 0 0\nO 0 0 1.15\n');
      fs.writeFileSync(path.join(ws, 'mol.inp'), '! PBE0 def2-SVP\n* xyzfile -1 2 mol.xyz\n');
      const g = await call<LoadedGeometry>('loadGeometry', { path: path.join(ws, 'mol.inp') }, ctx);
      assert.deepStrictEqual([g.charge, g.multiplicity, g.atoms.length], [-1, 2, 2]);
      assert.strictEqual(g.xyzPath, path.join(ws, 'mol.xyz'));
      assert.match(g.note ?? '', /xyzfile/);
    });

    it('reports an .inp whose xyzfile is missing', async () => {
      await assert.rejects(call('loadGeometry', { path: path.join(SNAPSHOTS, 'composite-xyzfile.orca.inp') }, ctx), /molecule\.xyz, which does not exist/);
    });

    it('takes the final geometry of the last job of an .out, and charge/multiplicity from the input echo', async () => {
      fs.writeFileSync(path.join(ws, 'opt.out'), OPT_OUT);
      const g = await call<LoadedGeometry>('loadGeometry', { path: path.join(ws, 'opt.out') }, ctx);
      assert.strictEqual(g.kind, 'out');
      assert.strictEqual(g.atoms[0].z, 0.01);
      assert.strictEqual(g.atoms[1].y, 0.757);
      assert.deepStrictEqual([g.charge, g.multiplicity], [1, 2]);
      assert.match(g.note ?? '', /final geometry.*\(optimized\)/);
    });

    it('reports an .out without coordinates', async () => {
      await assert.rejects(call('loadGeometry', { path: path.join(FIXTURES, 'calcs', 'orca', 'opt_ok.out') }, ctx), /no CARTESIAN COORDINATES/);
    });

    it('refuses paths outside the workspace and unsupported extensions', async () => {
      await assert.rejects(call('loadGeometry', { path: path.join(os.tmpdir(), 'elsewhere.xyz') }, fakeContext([ws])), /outside the workspace/);
      await assert.rejects(call('loadGeometry', { path: 'relative.xyz' }, ctx), /absolute/);
      fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
      await assert.rejects(call('loadGeometry', { path: path.join(ws, 'a.txt') }, ctx), /use an \.xyz/);
    });

    it('allows a file the user picked outside the workspace', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-picked-'));
      try {
        const file = path.join(outside, 'w.xyz');
        fs.writeFileSync(file, '1\n\nHe 0 0 0\n');
        const c = fakeContext([ws]);
        c.picks = [file];
        const g = await call<LoadedGeometry | null>('pickGeometry', {}, c);
        assert.strictEqual(g?.atoms[0].symbol, 'He');
        const again = await call<LoadedGeometry>('loadGeometry', { path: file }, c);
        assert.strictEqual(again.frames, 1);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('returns null when the picker is cancelled', async () => {
      assert.strictEqual(await call('pickGeometry', {}, ctx), null);
    });
  });

  describe('saving', () => {
    it('computes the save path next to the source, else in the first workspace folder', async () => {
      const src = path.join(FIXTURES, 'xyz', 'three.xyz');
      assert.strictEqual(await call('savePath', { fileName: 'job.inp', sourcePath: src }, ctx), path.join(FIXTURES, 'xyz', 'job.inp'));
      assert.strictEqual(await call('savePath', { fileName: 'job.inp' }, ctx), path.join(ws, 'job.inp'));
      assert.strictEqual(await call('savePath', { fileName: '../../evil.inp' }, ctx), path.join(ws, 'evil.inp'), 'directories in the name are dropped');
      await assert.rejects(call('savePath', { fileName: 'a.inp' }, fakeContext([])), /No workspace folder/);
      await assert.rejects(call('savePath', { fileName: '' }, ctx), /Missing file name/);
    });

    it('writes next to the source, adds the xyzfile companion and opens the file', async () => {
      fs.writeFileSync(path.join(ws, 'geom.xyz'), '1\n\nHe 0 0 0\n');
      const r = await call<SaveInputResult>('saveInput', {
        text: '! HF\n', fileName: 'he_hf_sp.inp', sourcePath: path.join(ws, 'geom.xyz'), open: true,
        companion: { name: 'he_hf_sp.xyz', content: '1\n\nHe 0 0 0\n' }
      }, ctx);
      assert.strictEqual(r.path, path.join(ws, 'he_hf_sp.inp'));
      assert.strictEqual(ctx.saved[0].path, path.join(ws, 'he_hf_sp.inp'));
      assert.deepStrictEqual(ctx.saved[0].filters, { 'ORCA input': ['inp'] });
      assert.strictEqual(r.companionWritten, path.join(ws, 'he_hf_sp.xyz'));
      assert.strictEqual(fs.readFileSync(path.join(ws, 'he_hf_sp.xyz'), 'utf8'), '1\n\nHe 0 0 0\n');
      assert.deepStrictEqual(ctx.opened, [{ path: r.path, beside: true }]);
    });

    it('keeps an existing companion and uses a dialog when asked', async () => {
      fs.writeFileSync(path.join(ws, 'x.xyz'), 'original');
      const r = await call<SaveInputResult>('saveInput', { text: 'print(1)\n', fileName: 'x.py', dialog: true, companion: { name: 'x.xyz', content: 'new' } }, ctx);
      assert.strictEqual(ctx.saved[0].path, undefined, 'no fixed path: the save dialog decides');
      assert.deepStrictEqual(ctx.saved[0].filters, { 'Python script': ['py'] });
      assert.strictEqual(r.companionWritten, undefined);
      const c2 = fakeContext([ws]);
      c2.saveFile = async () => undefined;
      assert.deepStrictEqual(await call('saveInput', { text: 'x', fileName: 'y.inp', dialog: true }, c2), {}, 'cancelled');
    });
  });

  describe('batches', () => {
    const spec = () => applyTemplate('tddft-spectrum', defaultSpec());

    it('plans one job per frame of pasted text, honouring maxFrames and the dir prefix', async () => {
      const r = await call<BatchPlanResult>('planBatch', { source: { text: XYZ2 }, spec: spec(), program: 'orca', dirPrefix: 'geoms/' }, ctx);
      assert.strictEqual(r.error, undefined);
      assert.deepStrictEqual([r.totalFrames, r.frames, r.fileCount], [2, 2, 5]);
      assert.deepStrictEqual(r.files.map(f => f.relPath), ['geoms/geom_0001/job.inp', 'geoms/geom_0002/job.inp', 'dirs.txt', 'run_all.sh', 'submit_slurm.sh']);
      assert.strictEqual(r.sampleJob?.relPath, 'geoms/geom_0001/job.inp');
      assert.match(r.sampleJob!.content, /CAM-B3LYP/);
      assert.ok(r.totalBytes > 0 && r.runAll && r.slurm);
      assert.strictEqual(r.defaultTarget, path.join(ws, 'batch_orca'));
      const one = await call<BatchPlanResult>('planBatch', { source: { text: XYZ2 }, spec: spec(), program: 'pyscf', maxFrames: 1, slurm: false }, ctx);
      assert.deepStrictEqual(one.files.map(f => f.relPath), ['geom_0001/geom.xyz', 'geom_0001/run.py', 'dirs.txt', 'run_all.sh']);
      assert.strictEqual(one.sampleJob?.relPath, 'geom_0001/run.py', 'the preview shows the script, not the geometry');
    });

    it('plans from an ensemble file and suggests a folder next to it', async () => {
      const file = path.join(FIXTURES, 'xyz', 'three.xyz');
      const r = await call<BatchPlanResult>('planBatch', { source: { path: file }, spec: spec(), program: 'orca' }, ctx);
      assert.strictEqual(r.frames, 3);
      assert.strictEqual(r.defaultTarget, path.join(FIXTURES, 'xyz', 'three_orca_batch'));
    });

    it('returns the generator error instead of throwing', async () => {
      const bad = spec();
      bad.excited.method = 'adc3';
      const r = await call<BatchPlanResult>('planBatch', { source: { text: XYZ2 }, spec: bad, program: 'orca' }, ctx);
      assert.match(r.error ?? '', /PySCF only/);
      assert.deepStrictEqual([r.totalFrames, r.fileCount], [2, 0]);
    });

    it('writes the batch, then asks before overwriting and writes nothing when declined', async () => {
      const target = path.join(ws, 'batch');
      const params = { source: { text: XYZ2 }, spec: spec(), program: 'orca', target };
      const first = await call<WriteBatchResult>('writeBatch', params, ctx);
      assert.deepStrictEqual(first, { status: 'written', folder: target, written: 5 });
      assert.ok(fs.readFileSync(path.join(target, 'geom_0002', 'job.inp'), 'utf8').includes('frame b'));
      assert.strictEqual(ctx.confirms.length, 0);

      fs.writeFileSync(path.join(target, 'run_all.sh'), 'mine');
      ctx.answer = false;
      const declined = await call<WriteBatchResult>('writeBatch', params, ctx);
      assert.deepStrictEqual(declined, { status: 'cancelled' });
      assert.strictEqual(ctx.confirms.length, 1);
      assert.match(ctx.confirms[0].message, /5 of 5 files already exist/);
      assert.match(ctx.confirms[0].detail ?? '', /geom_0001\/job\.inp/);
      assert.strictEqual(fs.readFileSync(path.join(target, 'run_all.sh'), 'utf8'), 'mine');

      ctx.answer = true;
      const replaced = await call<WriteBatchResult>('writeBatch', params, ctx);
      assert.strictEqual(replaced.status, 'written');
      assert.notStrictEqual(fs.readFileSync(path.join(target, 'run_all.sh'), 'utf8'), 'mine');
    });

    it('uses the folder picker without a target and refuses targets outside the workspace', async () => {
      assert.deepStrictEqual(await call('writeBatch', { source: { text: XYZ2 }, spec: spec(), program: 'orca' }, ctx), { status: 'cancelled' });
      ctx.picks = [path.join(ws, 'picked')];
      const r = await call<WriteBatchResult>('writeBatch', { source: { text: XYZ2 }, spec: spec(), program: 'orca' }, ctx);
      assert.deepStrictEqual(r, { status: 'written', folder: path.join(ws, 'picked'), written: 5 });
      await assert.rejects(call('writeBatch', { source: { text: XYZ2 }, spec: spec(), program: 'orca', target: path.join(os.tmpdir(), 'nope-batch') }, fakeContext([ws])), /outside the workspace/);
      await assert.rejects(call('writeBatch', { source: { text: XYZ2 }, spec: spec(), program: 'gaussian', target: ws }, ctx), /Unknown program/);
    });
  });

  describe('NEA command', () => {
    it('uses orcaInp.nea.scriptsDir and makes paths relative to the repository root', async () => {
      const scripts = path.join(ws, 'scripts');
      ctx.settings['nea.scriptsDir'] = scripts;
      const info = await call<NeaInfo>('neaInfo', {}, ctx);
      assert.deepStrictEqual([info.source, info.root], ['setting', ws]);
      const r = await call<NeaCommandResult>('neaCommand', {
        script: 'from_geometry.py', inputs: [path.join(ws, 'mols', 'ch2oo.xyz')], sampling: 'md', nsamples: 500, skip: 100, stride: 2, beads: 1, jobs: 8
      }, ctx);
      assert.strictEqual(r.cwd, ws);
      assert.strictEqual(r.found, true);
      assert.strictEqual(r.placeholder, undefined);
      const rel = path.join('mols', 'ch2oo.xyz');
      assert.strictEqual(r.command, `python scripts/from_geometry.py ${rel.split(path.sep).join('/')} --sampling md -n 500 --skip 100 --stride 2 --beads 1 -o runs/ch2oo_md --method 'adc(3)' --basis aug-cc-pVDZ --nstates 2 -j 8`);
    });

    it('finds the scripts by searching, compares several sets, and clamps numbers', async () => {
      ctx.found = [path.join(ws, 'repo', 'scripts', 'from_geometry.py')];
      const r = await call<NeaCommandResult>('neaCommand', {
        script: 'compare_ensembles.py', inputs: [path.join(ws, 'repo', 'a.xyz'), path.join(ws, 'repo', 'b.xyz')], nstates: -5, outDir: 'runs/cmp'
      }, ctx);
      assert.strictEqual(r.cwd, path.join(ws, 'repo'));
      assert.match(r.command, /^python scripts\/compare_ensembles\.py a=a\.xyz b=b\.xyz -o runs\/cmp .* --nstates 1 /);
    });

    it('falls back to the workspace and a placeholder input, and rejects unknown scripts', async () => {
      const r = await call<NeaCommandResult>('neaCommand', { script: 'from_ensemble.py', inputs: [] }, ctx);
      assert.deepStrictEqual([r.found, r.placeholder, r.cwd], [false, true, ws]);
      assert.match(r.command, /^python scripts\/from_ensemble\.py geoms\.xyz -o runs\/geoms /);
      await assert.rejects(call('neaCommand', { script: 'rm -rf.py', inputs: [] }, ctx), /Unknown NEA script/);
    });
  });
});
