// Isosurfaces of a scalar field on a cube grid (MO / density cube files) by
// marching tetrahedra: every grid cell is split into the six Kuhn
// tetrahedra that share the cell's main diagonal, so neighbouring cells
// split their common faces the same way and the surface has no cracks. No
// case tables are needed, vertices on shared edges are merged (indexed
// mesh, smooth shading) and normals come from the field gradient, so the
// result needs no post-processing. Axes may be non-orthogonal. This is the
// TypeScript counterpart of skimage.measure.marching_cubes as used by
// photoswitch scripts/plot_orbitals.py. Pure logic, no `vscode` import.

import type { CubeGrid } from './cube';

export interface IsoMesh {
  /** Vertex positions in Å, xyz interleaved. */
  positions: Float32Array;
  /** Unit normals pointing out of the region where sign·value > level. */
  normals: Float32Array;
  /** Triangle vertex indices, counter-clockwise seen from the outside. */
  indices: Uint32Array;
  /** Grid stride actually used (1 = full resolution). */
  step: number;
}

// Kuhn decomposition: each tetrahedron walks from corner (0,0,0) to (1,1,1)
// adding one axis at a time, in one of the six axis orders.
const PERMS: [number, number, number][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const TETS: [number, number, number][][] = PERMS.map(p => {
  const c: [number, number, number] = [0, 0, 0];
  const out: [number, number, number][] = [[0, 0, 0]];
  for (const ax of p) {
    c[ax] = 1;
    out.push([c[0], c[1], c[2]]);
  }
  return out;
});

function invert3(m: number[][]): number[][] {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-30) throw new Error('Cube axes are degenerate.');
  const s = 1 / det;
  return [
    [A * s, -(b * i - c * h) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, -(a * f - c * d) * s],
    [C * s, -(a * h - b * g) * s, (a * e - b * d) * s]
  ];
}

/**
 * Surface sign·value = level of a cube grid. Use sign −1 with a positive
 * level for the negative lobe of an orbital. When the full-resolution mesh
 * would exceed maxTriangles, the grid is subsampled (stride 2, 3, …).
 */
export function isosurface(grid: CubeGrid, level: number, sign: 1 | -1 = 1, maxTriangles = 400_000): IsoMesh {
  for (let step = 1; ; step++) {
    const m = extract(grid, level, sign, step, maxTriangles);
    if (m) return m;
  }
}

function extract(grid: CubeGrid, level: number, sign: 1 | -1, step: number, maxTriangles: number): IsoMesh | undefined {
  const [N0, N1, N2] = grid.n;
  const n0 = Math.floor((N0 - 1) / step) + 1;
  const n1 = Math.floor((N1 - 1) / step) + 1;
  const n2 = Math.floor((N2 - 1) / step) + 1;
  const vals = grid.values;
  const f = (i: number, j: number, k: number) => sign * vals[((i * step) * N1 + j * step) * N2 + k * step];
  const ax = grid.axes.map(r => r.map(x => x * step));
  // d f / d index = A · ∇f, so ∇f = A⁻¹ · (d f / d index)
  const inv = invert3(ax);
  const o = grid.origin;
  const id = (i: number, j: number, k: number) => (i * n1 + j) * n2 + k;
  const total = n0 * n1 * n2;

  const gradIdx = (i: number, j: number, k: number): [number, number, number] => {
    const di = i === 0 ? f(1, j, k) - f(0, j, k) : i === n0 - 1 ? f(i, j, k) - f(i - 1, j, k) : (f(i + 1, j, k) - f(i - 1, j, k)) / 2;
    const dj = j === 0 ? f(i, 1, k) - f(i, 0, k) : j === n1 - 1 ? f(i, j, k) - f(i, j - 1, k) : (f(i, j + 1, k) - f(i, j - 1, k)) / 2;
    const dk = k === 0 ? f(i, j, 1) - f(i, j, 0) : k === n2 - 1 ? f(i, j, k) - f(i, j, k - 1) : (f(i, j, k + 1) - f(i, j, k - 1)) / 2;
    return [di, dj, dk];
  };
  const toCart = (g: [number, number, number]): [number, number, number] => [
    inv[0][0] * g[0] + inv[0][1] * g[1] + inv[0][2] * g[2],
    inv[1][0] * g[0] + inv[1][1] * g[1] + inv[1][2] * g[2],
    inv[2][0] * g[0] + inv[2][1] * g[1] + inv[2][2] * g[2]
  ];

  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const edgeVertex = new Map<number, number>();

  const vertexOn = (a: [number, number, number], b: [number, number, number]): number => {
    let ia = id(a[0], a[1], a[2]);
    let ib = id(b[0], b[1], b[2]);
    if (ia > ib) {
      [ia, ib] = [ib, ia];
      [a, b] = [b, a];
    }
    const key = ia * total + ib;
    const hit = edgeVertex.get(key);
    if (hit !== undefined) return hit;
    const fa = f(a[0], a[1], a[2]);
    const fb = f(b[0], b[1], b[2]);
    const t = fb === fa ? 0.5 : Math.min(1, Math.max(0, (level - fa) / (fb - fa)));
    const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
    pos.push(
      o[0] + p[0] * ax[0][0] + p[1] * ax[1][0] + p[2] * ax[2][0],
      o[1] + p[0] * ax[0][1] + p[1] * ax[1][1] + p[2] * ax[2][1],
      o[2] + p[0] * ax[0][2] + p[1] * ax[1][2] + p[2] * ax[2][2]
    );
    const ga = gradIdx(a[0], a[1], a[2]);
    const gb = gradIdx(b[0], b[1], b[2]);
    const g = toCart([ga[0] + t * (gb[0] - ga[0]), ga[1] + t * (gb[1] - ga[1]), ga[2] + t * (gb[2] - ga[2])]);
    // outward = towards lower values
    const len = Math.hypot(g[0], g[1], g[2]) || 1;
    nrm.push(-g[0] / len, -g[1] / len, -g[2] / len);
    const v = pos.length / 3 - 1;
    edgeVertex.set(key, v);
    return v;
  };

  const tri = (a: number, b: number, c: number) => {
    // orient so the face normal agrees with the (outward) vertex normals
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (a === b || b === c || a === c) return;
    const nx = nrm[3 * a] + nrm[3 * b] + nrm[3 * c];
    const ny = nrm[3 * a + 1] + nrm[3 * b + 1] + nrm[3 * c + 1];
    const nz = nrm[3 * a + 2] + nrm[3 * b + 2] + nrm[3 * c + 2];
    if (cx * nx + cy * ny + cz * nz < 0) idx.push(a, c, b);
    else idx.push(a, b, c);
  };

  const corner: [number, number, number][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const inside = [false, false, false, false];
  for (let i = 0; i < n0 - 1; i++) {
    for (let j = 0; j < n1 - 1; j++) {
      for (let k = 0; k < n2 - 1; k++) {
        // quick reject: all 8 corners on one side
        let above = 0;
        for (let c = 0; c < 8; c++) if (f(i + (c >> 2), j + ((c >> 1) & 1), k + (c & 1)) > level) above++;
        if (above === 0 || above === 8) continue;
        for (const tet of TETS) {
          let nin = 0;
          for (let q = 0; q < 4; q++) {
            const c = tet[q];
            corner[q] = [i + c[0], j + c[1], k + c[2]];
            inside[q] = f(corner[q][0], corner[q][1], corner[q][2]) > level;
            if (inside[q]) nin++;
          }
          if (nin === 0 || nin === 4) continue;
          if (nin === 1 || nin === 3) {
            const lone = inside.findIndex(x => (nin === 1 ? x : !x));
            const others = [0, 1, 2, 3].filter(q => q !== lone);
            tri(vertexOn(corner[lone], corner[others[0]]), vertexOn(corner[lone], corner[others[1]]), vertexOn(corner[lone], corner[others[2]]));
          } else {
            const ins = [0, 1, 2, 3].filter(q => inside[q]);
            const outs = [0, 1, 2, 3].filter(q => !inside[q]);
            const [a, b] = ins;
            const [c, d] = outs;
            const ac = vertexOn(corner[a], corner[c]);
            const ad = vertexOn(corner[a], corner[d]);
            const bd = vertexOn(corner[b], corner[d]);
            const bc = vertexOn(corner[b], corner[c]);
            tri(ac, ad, bd);
            tri(ac, bd, bc);
          }
          if (idx.length / 3 > maxTriangles) return undefined;
        }
      }
    }
  }
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), indices: Uint32Array.from(idx), step };
}

/** Surface area (Å²) of a mesh. */
export function meshArea(m: IsoMesh): number {
  let s = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t], b = 3 * m.indices[t + 1], c = 3 * m.indices[t + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}

/** Enclosed volume (Å³) of a closed, outward-oriented mesh (divergence theorem). */
export function meshVolume(m: IsoMesh): number {
  let s = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = 3 * m.indices[t], b = 3 * m.indices[t + 1], c = 3 * m.indices[t + 2];
    s += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return s / 6;
}
