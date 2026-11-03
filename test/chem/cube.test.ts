import * as assert from 'assert';
import { BOHR_TO_ANGSTROM } from '../../src/chem/elements';
import { cubeStats, moFromCubeName, parseCube } from '../../src/chem/cube';
import { isosurface, meshArea, meshVolume } from '../../src/chem/marchingCubes';

/** Cube text of f(x, y, z) on an n³ grid with spacing h (bohr), origin at -(n-1)h/2. */
export function syntheticCube(n: number, h: number, f: (x: number, y: number, z: number) => number, opts: { negativeNatoms?: boolean } = {}): string {
  const o = (-(n - 1) * h) / 2;
  const lines = ['synthetic', 'test cube'];
  lines.push(`${opts.negativeNatoms ? -1 : 1} ${o} ${o} ${o}`);
  lines.push(`${n} ${h} 0 0`, `${n} 0 ${h} 0`, `${n} 0 0 ${h}`);
  lines.push('6 0.0 0.0 0.0 0.0');
  if (opts.negativeNatoms) lines.push('1 33');
  const vals: string[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) vals.push(f(o + i * h, o + j * h, o + k * h).toExponential(5));
    }
  }
  for (let i = 0; i < vals.length; i += 6) lines.push(vals.slice(i, i + 6).join(' '));
  return lines.join('\n') + '\n';
}

describe('cube files', () => {
  it('reads the header, converts bohr to Å and orders values with z fastest', () => {
    const g = parseCube(syntheticCube(5, 0.5, (x, y, z) => 100 * x + 10 * y + z));
    assert.deepStrictEqual(g.n, [5, 5, 5]);
    assert.ok(Math.abs(g.axes[0][0] - 0.5 * BOHR_TO_ANGSTROM) < 1e-9);
    assert.ok(Math.abs(g.origin[0] + 1 * BOHR_TO_ANGSTROM) < 1e-9);
    assert.strictEqual(g.atoms[0].symbol, 'C');
    // value at (i, j, k) = (1, 2, 3): x = -0.5, y = 0, z = 0.5
    assert.ok(Math.abs(g.values[(1 * 5 + 2) * 5 + 3] - (100 * -0.5 + 0 + 0.5)) < 1e-3);
  });

  it('skips the MO id line of a negative-natoms file', () => {
    const g = parseCube(syntheticCube(4, 0.5, () => 1, { negativeNatoms: true }));
    assert.deepStrictEqual(g.moIds, [33]);
    assert.strictEqual(g.values.length, 64);
    assert.ok(g.values.every(v => v === 1));
  });

  it('rejects a truncated file', () => {
    const text = syntheticCube(4, 0.5, () => 1).split('\n').slice(0, 12).join('\n');
    assert.throws(() => parseCube(text), /expected 64 values/);
  });

  it('finds the MO index in ORCA-style file names', () => {
    assert.deepStrictEqual(moFromCubeName('trans_mo33.cube'), { mo: 33, spin: 'a' });
    assert.deepStrictEqual(moFromCubeName('mol.mo5b.cube'), { mo: 5, spin: 'b' });
    assert.strictEqual(moFromCubeName('density.cube'), undefined);
  });
});

describe('isosurfaces (marching tetrahedra)', () => {
  // radial field f = R0 − r: the surface f = 0.5 is a sphere of radius R0 − 0.5 (bohr)
  const R0 = 3;
  const text = syntheticCube(41, 0.2, (x, y, z) => R0 - Math.hypot(x, y, z));
  const g = parseCube(text);

  it('gives a closed sphere with the analytic area and volume', () => {
    const m = isosurface(g, 0.5);
    const r = 2.5 * BOHR_TO_ANGSTROM;
    assert.ok(Math.abs(meshArea(m) / (4 * Math.PI * r * r) - 1) < 0.02, `area ${meshArea(m)}`);
    assert.ok(Math.abs(meshVolume(m) / ((4 / 3) * Math.PI * r ** 3) - 1) < 0.02, `volume ${meshVolume(m)}`);
    // closed, consistently oriented: every directed edge appears once and its reverse once
    const edges = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
        edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1);
      }
    }
    for (const [k, c] of edges) {
      const [a, b] = k.split('>');
      assert.strictEqual(c, 1);
      assert.strictEqual(edges.get(`${b}>${a}`), 1, `edge ${k} has no twin`);
    }
  });

  it('points normals outwards (away from the high-value region)', () => {
    const m = isosurface(g, 0.5);
    for (let v = 0; v < m.positions.length; v += 3 * 97) {
      const dot = m.positions[v] * m.normals[v] + m.positions[v + 1] * m.normals[v + 1] + m.positions[v + 2] * m.normals[v + 2];
      assert.ok(dot > 0);
    }
  });

  it('extracts the negative lobe with sign −1 and subsamples above maxTriangles', () => {
    const p = parseCube(syntheticCube(31, 0.3, (x, _y, z) => x * Math.exp(-Math.hypot(x, _y, z))));
    const pos = isosurface(p, 0.05, 1);
    const neg = isosurface(p, 0.05, -1);
    assert.ok(pos.indices.length > 0 && neg.indices.length > 0);
    let mx = -Infinity;
    for (let v = 0; v < neg.positions.length; v += 3) mx = Math.max(mx, neg.positions[v]);
    assert.ok(mx < 0, 'negative lobe lies at x < 0');
    assert.ok(Math.abs(meshArea(pos) - meshArea(neg)) / meshArea(pos) < 0.02, 'p orbital lobes are mirror images');
    const coarse = isosurface(p, 0.05, 1, Math.floor(pos.indices.length / 3 / 2));
    assert.ok(coarse.step > 1);
    assert.strictEqual(cubeStats(p).absMax > 0.3, true);
  });
});
