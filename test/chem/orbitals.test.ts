import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { moComposition, parseOrbitalData, planeNormal } from '../../src/chem/orbitals';
import { parseOrcaOutput } from '../../src/outparser/parse';

// photoswitch 06-orbitals/trans.out: ZINDO/S + CIS(2 roots) on trans-azobenzene with print[p_mos]
const FIX = path.join(__dirname, '..', 'fixtures', 'viewer');
const text = fs.readFileSync(path.join(FIX, 'trans.out'), 'utf8');
const parsed = parseOrcaOutput(text);
const fosc = parsed.jobs[parsed.jobs.length - 1].excitations?.map(e => e.fosc);
const data = parseOrbitalData(text, fosc);

describe('orbitals from an ORCA .out', () => {
  it('reads the MO energies and finds HOMO 33 / LUMO 34 (68 valence electrons)', () => {
    assert.strictEqual(data.sets.length, 1);
    const s = data.sets[0];
    assert.strictEqual(s.spin, 'restricted');
    assert.strictEqual(s.homo, 33);
    // ORBITAL ENERGIES prints only part of the virtuals; the coefficient block fills all 66
    assert.strictEqual(s.levels.length, 66);
    const homo = s.levels.find(l => l.index === 33)!;
    const lumo = s.levels.find(l => l.index === 34)!;
    assert.ok(Math.abs(homo.energyEv + 8.37) < 0.01, `HOMO ${homo.energyEv}`);
    assert.ok(Math.abs(lumo.energyEv + 1.13) < 0.01, `LUMO ${lumo.energyEv}`);
  });

  it('reads the coefficient matrix (66 valence basis functions)', () => {
    const c = data.coefficients[0];
    assert.strictEqual(c.basis.length, 66);
    assert.deepStrictEqual(c.basis[0], { atom: 0, element: 'N', label: '1s' });
    assert.strictEqual(c.coefficients.get(0)!.length, 66);
    // orthogonal ZINDO basis: c² sums to 1
    const sum = c.coefficients.get(33)!.reduce((a, x) => a + x * x, 0);
    assert.ok(Math.abs(sum - 1) < 1e-3);
  });

  it('reads the CIS states with their i → a weights and oscillator strengths', () => {
    assert.strictEqual(data.states.length, 2);
    const [s1, s2] = data.states;
    assert.strictEqual(s1.method, 'CIS');
    assert.strictEqual(s1.multiplicity, 'singlet');
    assert.ok(Math.abs(s1.energyEv - 2.424) < 1e-6);
    assert.deepStrictEqual([s1.contributions[0].from, s1.contributions[0].to], [29, 34]);
    assert.ok(Math.abs(s1.contributions[0].weight - 0.853321) < 1e-9);
    assert.deepStrictEqual([s2.contributions[0].from, s2.contributions[0].to], [33, 34]);
    assert.ok(Math.abs(s2.contributions[0].weight - 0.956087) < 1e-9);
    assert.ok(Math.abs(s2.fosc! - 0.8755) < 1e-4);
  });

  it('reproduces mo_character.py: N fraction and π character (06-orbitals/NOTES.md)', () => {
    const geom = parsed.jobs[parsed.jobs.length - 1].finalGeometry!;
    const xyz = geom.map(a => [a.x, a.y, a.z] as [number, number, number]);
    // normal of the C2–N0=N1–C13 plane: (x2 − x0) × (x13 − x1)
    const n = planeNormal(xyz, [2, 0, 1, 13])!;
    const expected: Record<number, [number, number]> = { 29: [0.81, 0.0], 30: [0.06, 1.0], 33: [0.13, 1.0], 34: [0.58, 1.0], 37: [0.02, 1.0], 38: [0.28, 1.0] };
    for (const [mo, [nFrac, pi]] of Object.entries(expected)) {
      const c = moComposition(data.coefficients[0], Number(mo), geom.length, n)!;
      assert.ok(Math.abs(c.elements.N - nFrac) < 0.006, `MO ${mo}: N ${c.elements.N}`);
      assert.ok(Math.abs(c.pi! - pi) < 0.006, `MO ${mo}: π ${c.pi}`);
      const total = c.atoms.reduce((a, x) => a + x, 0);
      assert.ok(Math.abs(total - 1) < 1e-9);
    }
  });

  it('returns nothing for outputs without orbital sections', () => {
    const empty = parseOrbitalData('no orbitals here\n');
    assert.deepStrictEqual([empty.sets, empty.coefficients, empty.states], [[], [], []]);
  });

  it('reads UHF spin-up and spin-down energies', () => {
    const uhf = [
      'ORBITAL ENERGIES', '----------------', '                 SPIN UP ORBITALS',
      '  NO   OCC          E(Eh)            E(eV) ',
      '   0   1.0000      -0.500000       -13.6057 ',
      '   1   0.0000       0.100000         2.7211 ',
      '', '                 SPIN DOWN ORBITALS',
      '  NO   OCC          E(Eh)            E(eV) ',
      '   0   0.0000      -0.400000       -10.8846 ',
      '   1   0.0000       0.200000         5.4423 ', ''
    ].join('\n');
    const d = parseOrbitalData(uhf);
    assert.deepStrictEqual(d.sets.map(s => [s.spin, s.homo, s.levels.length]), [['alpha', 0, 2], ['beta', -1, 2]]);
  });
});
