import * as assert from 'assert';
import * as path from 'path';
import { parseComment, parseMultiXyz, readOutStructure, readXyzStructure } from '../../src/chem/trajectory3d';

const FIX = path.join(__dirname, '..', 'fixtures');

describe('3D viewer structures', () => {
  it('reads an ORCA .allxyz relaxed scan with its ">" separators and pairs it with .relaxscanact.dat', () => {
    const s = readXyzStructure(path.join(FIX, 'viewer', 'torsion.allxyz'));
    assert.strictEqual(s.frames.length, 3);
    assert.strictEqual(s.symbols.length, 24);
    assert.strictEqual(s.frames[0].length, 72);
    assert.deepStrictEqual(s.coordinate?.values, [180, 175, 170]);
    assert.ok(Math.abs((s.energies![2] as number) + 572.78829208) < 1e-8);
    assert.match(s.note ?? '', /relaxed scan, 3 points/);
  });

  it('takes energy and scan coordinate from envelope comment lines', () => {
    const s = readXyzStructure(path.join(FIX, 'viewer', 'torsion_envelope.xyz'));
    assert.strictEqual(s.frames.length, 3);
    assert.strictEqual(s.coordinate?.label, 'torsion');
    assert.deepStrictEqual(s.coordinate?.values, [180, 175, 170]);
    assert.ok(Math.abs((s.energies![0] as number) + 572.789576541) < 1e-9);
  });

  it('parses comment lines', () => {
    assert.deepStrictEqual(parseComment('Coordinates from ORCA-job torsion Relaxed Surface Scan Step 1 E -572.789576541331'), { energy: -572.789576541331 });
    assert.deepStrictEqual(parseComment('inversion 135.5 E -572.7 trans'), { energy: -572.7, coordinate: 135.5, coordLabel: 'inversion' });
    assert.deepStrictEqual(parseComment(' -76.4 '), { energy: -76.4 });
    assert.deepStrictEqual(parseComment('frame 12'), {});
  });

  it('strides and caps long trajectories', () => {
    const frame = (i: number) => `2\nframe ${i}\nH 0 0 ${i}\nH 0 0 ${i + 0.74}\n`;
    const text = Array.from({ length: 10 }, (_, i) => frame(i)).join('');
    const all = parseMultiXyz(text);
    assert.deepStrictEqual([all.frames.length, all.total], [10, 10]);
    const every3 = parseMultiXyz(text, 3);
    assert.deepStrictEqual(every3.frames.map(f => f[2]), [0, 3, 6, 9]);
    const capped = parseMultiXyz(text, 1, 4);
    assert.deepStrictEqual([capped.frames.length, capped.truncated], [4, true]);
    // a truncated last frame is ignored
    assert.strictEqual(parseMultiXyz(text + '2\ncut\nH 0 0 0\n').frames.length, 10);
  });

  it('reads the geometry steps of an optimization .out with their energies', () => {
    const block = (z: number) => ['---------------------------------', 'CARTESIAN COORDINATES (ANGSTROEM)', '---------------------------------',
      `  H      0.000000    0.000000    ${z.toFixed(6)}`, `  H      0.000000    0.000000    ${(z + 0.74).toFixed(6)}`, ''].join('\n');
    const out = [block(0), 'FINAL SINGLE POINT ENERGY        -1.10', block(0.01), 'FINAL SINGLE POINT ENERGY        -1.17',
      '*** OPTIMIZATION RUN DONE ***', block(0.01)].join('\n');
    const s = readOutStructure(out);
    // the final repeat of the converged geometry is dropped
    assert.strictEqual(s.frames.length, 2);
    assert.deepStrictEqual(s.energies, [-1.1, -1.17]);
    assert.deepStrictEqual(s.symbols, ['H', 'H']);
    assert.strictEqual(s.note, '2 geometry steps');
  });

  it('throws on an output without coordinates', () => {
    assert.throws(() => readOutStructure('nothing'), /No CARTESIAN COORDINATES/);
  });
});
