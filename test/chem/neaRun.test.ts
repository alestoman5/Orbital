import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countXyzFrames, findGeomSets, readGeomSet } from '../../src/chem/neaRun';

function geom(root: string, name: string, result?: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  if (result !== undefined) {
    fs.writeFileSync(path.join(root, name, 'result.json'), result);
  }
}

describe('chem/neaRun', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nea-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('classifies geometries like scripts/nea/batch.py status()', () => {
    const g = path.join(tmp, 'geoms');
    geom(g, 'geom_0001', JSON.stringify({ converged: true, excitation_energies_ev: [2.97, 3.73], oscillator_strengths: [5e-5, 0.126], time_adc_s: 95 }));
    geom(g, 'geom_0002', JSON.stringify({ converged: false }));
    geom(g, 'geom_0003', '{ broken');
    geom(g, 'geom_0010');
    const s = readGeomSet(g);
    assert.deepStrictEqual(s.byStatus, { ok: ['geom_0001'], 'not converged': ['geom_0002'], unreadable: ['geom_0003'], 'not started': ['geom_0010'] });
    assert.deepStrictEqual(s.sticks, [{ energyEv: 2.97, weight: 5e-5 }, { energyEv: 3.73, weight: 0.126 }]);
    assert.deepStrictEqual(s.adcTimes, [95]);
  });

  it('finds geometry sets in the three layouts', () => {
    geom(path.join(tmp, 'a'), 'geom_0001');
    geom(path.join(tmp, 'b', 'geoms'), 'geom_0001');
    geom(path.join(tmp, 'c', 'gle', 'geoms'), 'geom_0001');
    geom(path.join(tmp, 'c', 'pigle', 'geoms'), 'geom_0001');
    assert.deepStrictEqual(findGeomSets(path.join(tmp, 'a')), [path.join(tmp, 'a')]);
    assert.deepStrictEqual(findGeomSets(path.join(tmp, 'b')), [path.join(tmp, 'b', 'geoms')]);
    assert.deepStrictEqual(findGeomSets(path.join(tmp, 'c')), ['gle', 'pigle'].map(l => path.join(tmp, 'c', l, 'geoms')));
  });

  it('counts frames of a multi-XYZ file', () => {
    assert.strictEqual(countXyzFrames('2\nc\nH 0 0 0\nH 0 0 1\n2\nc\nH 0 0 0\nH 0 0 1\n'), 2);
  });
});
