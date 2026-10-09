import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseOrcaInput, parseXyz } from '../../src/chem/inputFile';
import { applyTemplate, planBatch, splitEnsemble, writeBatch } from '../../src/inputs';
import { matchSnapshot } from './helpers';

const FRAME = (dz: number, comment: string) => [
  '3', comment,
  `O 0.0 0.0 ${(0.1173 + dz).toFixed(4)}`,
  'H 0.0 0.7572 -0.4692',
  'H 0.0 -0.7572 -0.4692'
].join('\n');

const ENSEMBLE = [FRAME(0, 'sample 1'), FRAME(0.01, 'sample 2'), FRAME(-0.01, 'sample 3')].join('\n') + '\n';

describe('inputs: splitEnsemble', () => {
  it('splits a multi-XYZ text into named frames', () => {
    const frames = splitEnsemble(ENSEMBLE);
    assert.deepStrictEqual(frames.map(f => f.name), ['geom_0001', 'geom_0002', 'geom_0003']);
    assert.strictEqual(frames[1].comment, 'sample 2');
    assert.strictEqual(frames[1].atoms[0].z, 0.1273);
    assert.deepStrictEqual(parseXyz(frames[2].xyz), frames[2].atoms);
  });

  it('honours prefix, digits and maxFrames, and stops at a malformed frame', () => {
    assert.deepStrictEqual(splitEnsemble(ENSEMBLE, { prefix: 'g', digits: 2, maxFrames: 2 }).map(f => f.name), ['g01', 'g02']);
    const broken = FRAME(0, 'ok') + '\n3\ntruncated\nO 0 0 0\n';
    assert.strictEqual(splitEnsemble(broken).length, 1);
    assert.strictEqual(splitEnsemble(FRAME(0, 'x').replace(/\n/g, '\r\n')).length, 1);
    assert.strictEqual(splitEnsemble('not an xyz').length, 0);
  });
});

describe('inputs: planBatch', () => {
  const frames = splitEnsemble(ENSEMBLE);

  it('plans one ORCA job.inp per geometry plus run scripts', () => {
    const spec = applyTemplate('tddft-spectrum');
    spec.resources = { nprocs: 2, maxcoreMB: 2000 };
    const files = planBatch(spec, frames, 'orca', { dirPrefix: 'geoms/' });
    assert.deepStrictEqual(files.map(f => f.relPath), [
      'geoms/geom_0001/job.inp', 'geoms/geom_0002/job.inp', 'geoms/geom_0003/job.inp',
      'dirs.txt', 'run_all.sh', 'submit_slurm.sh'
    ]);
    const inp = parseOrcaInput(files[1].content);
    assert.strictEqual(inp.coords!.atoms[0].z, 0.1273);
    assert.match(files[1].content, /^# TD-DFT vertical spectrum — geom_0002$/m);
    assert.match(files[1].content, /^# Geometry: sample 2$/m);
    assert.strictEqual(files[3].content, 'geoms/geom_0001\ngeoms/geom_0002\ngeoms/geom_0003\n');
    const runAll = files[4].content;
    assert.match(runAll, /NPROCS=2/);
    assert.match(runAll, /xargs -P "\$JOBS"/);
    assert.match(runAll, /ORCA TERMINATED NORMALLY/);
    assert.match(runAll, /job\.inp > job\.out/);
    assert.ok(files[4].executable);
    matchSnapshot('batch.orca.run_all.sh', runAll);
    matchSnapshot('batch.orca.submit_slurm.sh', files[5].content);
  });

  it('plans PySCF run.py + geom.xyz per geometry; run.py reads geom.xyz', () => {
    const files = planBatch(applyTemplate('adc3-sp'), frames, 'pyscf', { slurm: false });
    assert.deepStrictEqual(files.map(f => f.relPath), [
      'geom_0001/geom.xyz', 'geom_0001/run.py', 'geom_0002/geom.xyz', 'geom_0002/run.py',
      'geom_0003/geom.xyz', 'geom_0003/run.py', 'dirs.txt', 'run_all.sh'
    ]);
    assert.match(files[1].content, /p\.add_argument\("geom", nargs="\?", default="geom\.xyz"/);
    assert.ok(!/GEOMETRY = """/.test(files[1].content), 'no inline geometry');
    assert.strictEqual(files[0].content, frames[0].xyz);
    const runAll = files[7].content;
    assert.match(runAll, /\[ -f "\$d\/result\.json" \]/);
    assert.match(runAll, /run\.py geom\.xyz result\.json > run\.log 2>&1/);
    matchSnapshot('batch.pyscf.run_all.sh', runAll);
    matchSnapshot('batch.pyscf.submit_slurm.sh', planBatch(applyTemplate('adc3-sp'), frames, 'pyscf').pop()!.content);
  });

  it('throws when the spec cannot be generated, or when there is nothing to plan', () => {
    assert.throws(() => planBatch(applyTemplate('adc3-sp'), frames, 'orca'), /geom_0001: .*ADC\(3\)/);
    assert.throws(() => planBatch(applyTemplate('tddft-spectrum'), [], 'orca'), /No geometries/);
    assert.throws(() => planBatch(applyTemplate('tddft-spectrum'), frames, 'orca', { dirPrefix: '../x/' }), /inside/);
  });
});

describe('inputs: writeBatch', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-batch-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the files and refuses to overwrite unless asked', () => {
    const files = planBatch(applyTemplate('tddft-spectrum'), splitEnsemble(ENSEMBLE), 'orca');
    const written = writeBatch(root, files);
    assert.strictEqual(written.length, files.length);
    assert.strictEqual(fs.readFileSync(path.join(root, 'geom_0002', 'job.inp'), 'utf8'), files[1].content);
    fs.writeFileSync(path.join(root, 'dirs.txt'), 'edited');
    assert.throws(() => writeBatch(root, files), /already exist/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'dirs.txt'), 'utf8'), 'edited', 'nothing written on refusal');
    writeBatch(root, files, { overwrite: true });
    assert.strictEqual(fs.readFileSync(path.join(root, 'dirs.txt'), 'utf8'), files[3].content);
  });

  it('refuses paths that leave the root', () => {
    assert.throws(() => writeBatch(root, [{ relPath: '../evil.sh', content: '' }]), /outside/);
    assert.throws(() => writeBatch(root, [{ relPath: '/abs.sh', content: '' }]), /outside/);
  });
});
