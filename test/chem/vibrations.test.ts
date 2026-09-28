import * as assert from 'assert';
import {
  assessWignerReadiness,
  buildMolden,
  displaceAlongMode,
  findImaginaryModes,
  findSmallNegativeModes,
  isLinear,
  quantumToClassicalVarianceRatio,
  vibrationalDataFromJob
} from '../../src/chem/vibrations';
import { GeometryAtom, JobSegment } from '../../src/outparser/types';

const WATER: GeometryAtom[] = [
  { symbol: 'O', x: 0, y: 0, z: -0.0656 },
  { symbol: 'H', x: 0.757, y: 0, z: 0.5205 },
  { symbol: 'H', x: -0.757, y: 0, z: 0.5205 }
];

describe('chem/vibrations: imaginary modes', () => {
  const freqs = [0, 0, 0, 0, 0, 0, -312.4, -5.1, 1600, 3700];

  it('returns modes below the threshold, most negative first', () => {
    assert.deepStrictEqual(findImaginaryModes([0, -30, -400, 100]), [
      { index: 2, freq: -400 },
      { index: 1, freq: -30 }
    ]);
  });

  it('treats small negative values above the threshold as noise, not imaginary modes', () => {
    assert.deepStrictEqual(findImaginaryModes(freqs), [{ index: 6, freq: -312.4 }]);
    assert.deepStrictEqual(findSmallNegativeModes(freqs), [{ index: 7, freq: -5.1 }]);
    assert.deepStrictEqual(findImaginaryModes(freqs, -1), [{ index: 6, freq: -312.4 }, { index: 7, freq: -5.1 }]);
  });
});

describe('chem/vibrations: displaceAlongMode', () => {
  const mode = [0, 0, 0.07, 0.4, 0, -0.55, -0.4, 0, -0.55];

  it('moves the most-displaced atom by exactly maxDisplacement', () => {
    const d = displaceAlongMode(WATER, mode, 0.15, 1);
    const moved = d.map((a, i) => Math.hypot(a.x - WATER[i].x, a.y - WATER[i].y, a.z - WATER[i].z));
    assert.ok(Math.abs(Math.max(...moved) - 0.15) < 1e-12);
    // O moves proportionally less (0.07 vs |(0.4, 0, -0.55)|)
    assert.ok(Math.abs(moved[0] - (0.15 * 0.07) / Math.hypot(0.4, 0.55)) < 1e-12);
  });

  it('negative sign displaces the opposite way and keeps symbols', () => {
    const plus = displaceAlongMode(WATER, mode, 0.1, 1);
    const minus = displaceAlongMode(WATER, mode, 0.1, -1);
    assert.ok(Math.abs(plus[1].x - WATER[1].x + (minus[1].x - WATER[1].x)) < 1e-12);
    assert.deepStrictEqual(minus.map(a => a.symbol), ['O', 'H', 'H']);
  });

  it('rejects mode vectors of the wrong length or all zeros', () => {
    assert.throws(() => displaceAlongMode(WATER, [1, 0, 0], 0.1), /expected 9/);
    assert.throws(() => displaceAlongMode(WATER, new Array(9).fill(0), 0.1), /zero/);
  });
});

describe('chem/vibrations: buildMolden', () => {
  const data = {
    atoms: [
      { symbol: 'H', mass: 1.008, xBohr: 0, yBohr: 0, zBohr: -0.7 },
      { symbol: 'H', mass: 1.008, xBohr: 0, yBohr: 0, zBohr: 0.7 }
    ],
    frequenciesCm1: [0, 0, 0, 0, 0, 4400.123],
    normalModes: [
      [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [-0, 0, -0.7071068, 0, -0.0000001, 0.7071068]
    ]
  };

  it("writes the SHARC ORCA_freq.py layout: all 3N frequencies, bohr coordinates, 'vibration k' blocks, [INT]", () => {
    const text = buildMolden(data, [0, 0, 0, 0, 0, 12.5]);
    const lines = text.split('\n');
    assert.strictEqual(lines[0], '[MOLDEN FORMAT]');
    assert.strictEqual(lines[1], '[FREQ]');
    assert.strictEqual(lines[7], '4400.12');
    assert.strictEqual(lines[8], '[FR-COORD]');
    assert.strictEqual(lines[9], 'H 0.000000 0.000000 -0.700000');
    assert.ok(text.includes('vibration 6\n'));
    assert.ok(text.includes('[INT]\n'));
    assert.ok(text.endsWith('    12.500000000\n'));
  });

  it("keeps ORCA's '-0.000000' for negative values that round to zero (trailing space per row)", () => {
    const text = buildMolden(data);
    assert.ok(text.includes('vibration 6\n-0.000000 0.000000 -0.707107 \n0.000000 -0.000000 0.707107 \n'));
  });
});

describe('chem/vibrations: vibrationalDataFromJob', () => {
  const job: JobSegment = {
    scfCycles: [], optCycles: [], warnings: [],
    finalGeometry: WATER,
    frequenciesCm1: new Array(9).fill(0),
    normalModes: new Array(9).fill(new Array(9).fill(0))
  };

  it('prefers the bohr block (exact digits, masses) when present', () => {
    const bohr = WATER.map(a => ({ symbol: a.symbol, mass: 1, xBohr: 9, yBohr: 9, zBohr: 9 }));
    assert.strictEqual(vibrationalDataFromJob({ ...job, finalGeometryBohr: bohr })!.atoms[0].xBohr, 9);
    assert.ok(Math.abs(vibrationalDataFromJob(job)!.atoms[1].xBohr - 0.757 / 0.529177210903) < 1e-9);
  });

  it('returns undefined when sizes disagree', () => {
    assert.strictEqual(vibrationalDataFromJob({ ...job, frequenciesCm1: [1, 2] }), undefined);
  });
});

describe('chem/vibrations: Wigner readiness', () => {
  it('x·coth x ratio: ≈1 for soft modes, large for stiff modes, grows as T drops', () => {
    assert.ok(Math.abs(quantumToClassicalVarianceRatio(10, 300) - 1) < 1e-3);
    const stiff = quantumToClassicalVarianceRatio(3000, 300);
    assert.ok(stiff > 7 && stiff < 7.5, `got ${stiff}`); // x = 7.19 -> x coth x ≈ 7.19
    assert.ok(quantumToClassicalVarianceRatio(1500, 100) > quantumToClassicalVarianceRatio(1500, 300));
  });

  it('accepts a clean non-linear minimum (3N-6 modes)', () => {
    const r = assessWignerReadiness(WATER, [0, 0, 0, 0, 0, 0, 1600, 3700, 3800]);
    assert.ok(r.ok, r.problems.join());
    assert.strictEqual(r.expectedModes, 3);
    assert.strictEqual(r.modes.length, 3);
    assert.strictEqual(r.warnings.length, 0);
  });

  it('rejects a saddle point and flags soft modes', () => {
    const r = assessWignerReadiness(WATER, [0, 0, 0, 0, 0, 0, -312, 150, 3800]);
    assert.ok(!r.ok);
    assert.ok(r.problems[0].includes('saddle point'));
    assert.ok(r.warnings.some(w => w.includes('soft mode')));
  });

  it('flags a wrong mode count and an abnormal termination', () => {
    const r = assessWignerReadiness(WATER, [0, 0, 0, 0, 0, 0, 0, 3700, 3800], { terminatedNormally: false });
    assert.ok(r.problems.some(p => p.includes('did not terminate normally')));
    assert.ok(r.problems.some(p => p.includes('expected 3N-6 = 3')));
  });

  it('knows linear molecules have 3N-5 modes', () => {
    const co2: GeometryAtom[] = [
      { symbol: 'O', x: 0, y: 0, z: -1.16 },
      { symbol: 'C', x: 0, y: 0, z: 0 },
      { symbol: 'O', x: 0, y: 0, z: 1.16 }
    ];
    assert.ok(isLinear(co2));
    assert.ok(!isLinear(WATER));
    assert.strictEqual(assessWignerReadiness(co2, [0, 0, 0, 0, 0, 667, 667, 1388, 2349]).expectedModes, 4);
  });
});
