// Shared fixtures for the input-generator tests: plain-file snapshots and a
// set of specs beyond the templates that exercise the remaining code paths.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { InputSpec, Program, defaultSpec, TEMPLATES } from '../../src/inputs';

export const SNAPSHOT_DIR = path.join(__dirname, '__snapshots__');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

/** Compares `actual` with test/inputs/__snapshots__/<name>; UPDATE_SNAPSHOTS=1 rewrites the file. */
export function matchSnapshot(name: string, actual: string): void {
  const file = path.join(SNAPSHOT_DIR, name);
  if (UPDATE) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  if (!fs.existsSync(file)) {
    assert.fail(`Snapshot ${name} is missing; run the tests with UPDATE_SNAPSHOTS=1 to create it.`);
  }
  const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(actual, expected, `Snapshot ${name} differs; rerun with UPDATE_SNAPSHOTS=1 if the change is intended.`);
}

const OH = [
  { symbol: 'O', x: 0, y: 0, z: 0 },
  { symbol: 'H', x: 0, y: 0, z: 0.97 }
];

const FORMALDEHYDE = [
  { symbol: 'C', x: 0, y: 0, z: -0.5297 },
  { symbol: 'O', x: 0, y: 0, z: 0.6771 },
  { symbol: 'H', x: 0, y: 0.9353, z: -1.1145 },
  { symbol: 'H', x: 0, y: -0.9353, z: -1.1145 }
];

export interface Variant {
  id: string;
  programs: Program[];
  spec: InputSpec;
}

function variant(id: string, programs: Program[], edit: (s: InputSpec) => void): Variant {
  const s = defaultSpec();
  s.title = id;
  edit(s);
  return { id, programs, spec: s };
}

/** Extra specs (not templates) covering open shells, solvation, xyzfile, NumFreq, ... */
export const VARIANTS: Variant[] = [
  variant('uks-radical-opt', ['orca', 'pyscf'], s => {
    s.geometry.atoms = OH;
    s.multiplicity = 2;
    s.method.functional = 'B3LYP';
    s.dispersion = 'd4';
    s.job = 'opt';
    s.convergence = { scf: 'tight', opt: 'tight' };
  }),
  variant('smd-tda-triplets', ['orca', 'pyscf'], s => {
    s.geometry.atoms = FORMALDEHYDE;
    s.method.functional = 'wB97X-D3BJ';
    s.basis = 'def2-TZVPD';
    s.solvation = { model: 'smd', solvent: 'acetonitrile' };
    s.excited = { method: 'tddft', nroots: 6, triplets: true, tda: true, iroot: 1 };
  }),
  variant('composite-xyzfile', ['orca'], s => {
    s.geometry = { atoms: [], xyzFile: 'molecule.xyz' };
    s.method.functional = 'r2SCAN-3c';
    s.basis = '';
    s.job = 'opt-freq';
    s.comment = 'Cheap composite pre-optimization.\nGeometry from an external file.';
  }),
  variant('rimp2-optfreq', ['orca'], s => {
    s.method.family = 'mp2';
    s.basis = 'cc-pVTZ';
    s.job = 'opt-freq';
    s.resources = { nprocs: 1, maxcoreMB: 3000 };
  }),
  variant('ccsdt-allelectron', ['orca', 'pyscf'], s => {
    s.method.family = 'ccsd(t)';
    s.basis = 'cc-pVTZ';
    s.frozenCore = false;
    s.convergence.scf = 'verytight';
  }),
  variant('cis-cpcm', ['orca', 'pyscf'], s => {
    s.method.family = 'hf';
    s.dispersion = 'none';
    s.ri.mode = 'rij';
    s.solvation = { model: 'cpcm', solvent: 'water' };
    s.excited = { method: 'tddft', nroots: 4, triplets: false, tda: true, iroot: 0 };
  }),
  variant('tddft-excited-opt', ['orca'], s => {
    s.geometry.atoms = FORMALDEHYDE;
    s.method.functional = 'PBE0';
    s.job = 'opt';
    s.excited = { method: 'tddft', nroots: 3, triplets: false, tda: true, iroot: 1 };
  }),
  variant('angle-scan-rijk', ['orca', 'pyscf'], s => {
    s.method.family = 'hf';
    s.ri.mode = 'rijk';
    s.dispersion = 'none';
    s.job = 'scan';
    s.scan = { coordinate: 'A', atoms: [1, 0, 2], start: 100, end: 110, points: 6 };
  }),
  variant('sa-casscf-triplet', ['orca', 'pyscf'], s => {
    s.method.family = 'casscf';
    s.multiplicity = 3;
    s.cas = { nel: 4, norb: 4, nroots: 3 };
    s.basis = 'cc-pVDZ';
    s.job = 'sp';
  }),
  variant('gga-noRI-freq-anion', ['orca', 'pyscf'], s => {
    s.geometry.atoms = OH;
    s.charge = -1;
    s.method.functional = 'PBE';
    s.basis = 'def2-SVPD';
    s.ri.mode = 'none';
    s.job = 'freq';
    s.freq = { temperature: 350, pressureAtm: 2 };
    s.extras = { orca: '%output\n  Print[P_Hirshfeld] 1\nend', pyscf: 'print("user code runs here", mf.e_tot)' };
  })
];

/** Every (id, program, spec) the generators are expected to produce. */
export function allCases(): { id: string; program: Program; spec: InputSpec }[] {
  const out: { id: string; program: Program; spec: InputSpec }[] = [];
  for (const t of TEMPLATES) {
    for (const program of t.programs) {
      out.push({ id: t.id, program, spec: t.build() });
    }
  }
  for (const v of VARIANTS) {
    for (const program of v.programs) {
      out.push({ id: v.id, program, spec: v.spec });
    }
  }
  return out;
}
