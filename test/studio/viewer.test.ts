import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { clearCaches, cubesFor, host, plotsBlock } from '../../src/studio/tabs/viewer/host';
import type { IsoResult, OrbitalsResult, SourceList, StructureResult } from '../../src/studio/tabs/viewer/types';
import { syntheticCube } from '../chem/cube.test';

const FIX = path.join(__dirname, '..', 'fixtures', 'viewer');

function fakeContext(ws: string): HostContext {
  return {
    tab: 'viewer',
    extensionPath: '.',
    workspaceFolders: () => [ws],
    storageDir: () => undefined,
    config: (_k, fallback) => fallback,
    findFiles: async (glob: string) => {
      const ext = glob.slice(glob.lastIndexOf('.'));
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (p.endsWith(ext)) out.push(p);
        }
      };
      walk(ws);
      return out;
    },
    watch: () => ({ dispose() {} }),
    post: () => undefined,
    navigate: () => undefined,
    saveFile: async () => undefined,
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    runInTerminal: () => undefined,
    activeEditorPath: () => undefined,
    log: () => undefined
  };
}

describe('viewer host', () => {
  let ws: string;
  let ctx: HostContext;

  before(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-viewer-'));
    for (const f of ['trans.out', 'trans.xyz', 'torsion.allxyz', 'torsion.relaxscanact.dat']) fs.copyFileSync(path.join(FIX, f), path.join(ws, f));
    // a p-like orbital standing in for an ORCA %plots cube of MO 33
    fs.writeFileSync(path.join(ws, 'trans_mo33.cube'), syntheticCube(21, 0.4, (x, y, z) => z * Math.exp(-Math.hypot(x, y, z))));
    fs.writeFileSync(path.join(ws, 'other_mo1.cube'), syntheticCube(5, 0.4, () => 0));
    ctx = fakeContext(ws);
  });
  after(() => {
    clearCaches();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('lists structure files with their kind', async () => {
    const r = (await host.methods.list({}, ctx)) as SourceList;
    const kinds = Object.fromEntries(r.files.map(f => [path.basename(f.path), f.kind]));
    assert.deepStrictEqual(kinds, { 'trans.out': 'out', 'trans.xyz': 'xyz', 'torsion.allxyz': 'allxyz', 'trans_mo33.cube': 'cube', 'other_mo1.cube': 'cube' });
  });

  it('opens a relaxed scan with energies, coordinate and bonds', () => {
    const s = host.methods.open({ path: path.join(ws, 'torsion.allxyz') }, ctx) as StructureResult;
    assert.strictEqual(s.frames.length, 3);
    assert.deepStrictEqual(s.coordinate?.values, [180, 175, 170]);
    // azobenzene: 12 C–C, 10 C–H, 2 C–N, 1 N=N
    assert.strictEqual(s.bonds.length, 25);
    assert.strictEqual(s.hasOrbitals, false);
  });

  it('opens an output with orbitals and finds its cube files by name', () => {
    const s = host.methods.open({ path: path.join(ws, 'trans.out') }, ctx) as StructureResult;
    assert.strictEqual(s.hasOrbitals, true);
    assert.deepStrictEqual(s.cubes.map(c => [c.name, c.mo]), [['trans_mo33.cube', 33]]);
    assert.deepStrictEqual(cubesFor(path.join(ws, 'trans.xyz')).map(c => c.name), ['trans_mo33.cube']);
  });

  it('returns levels with composition, π fractions for a picked plane, states and cube links', () => {
    // 1-based atoms C3, N1, N2, C14 = 0-based C2–N0=N1–C13 of mo_character.py
    const r = host.methods.orbitals({ path: path.join(ws, 'trans.out'), plane: [3, 1, 2, 14] }, ctx) as OrbitalsResult;
    assert.strictEqual(r.method, 'ZINDO/S');
    assert.strictEqual(r.orthogonalBasis, true);
    assert.deepStrictEqual(r.plane, [3, 1, 2, 14]);
    const set = r.sets[0];
    assert.strictEqual(set.homo, 33);
    const mo29 = set.levels.find(l => l.index === 29)!;
    assert.ok(Math.abs(mo29.elements!.N - 0.81) < 0.006);
    assert.ok(mo29.pi! < 0.01);
    assert.ok(set.levels.find(l => l.index === 33)!.cube?.endsWith('trans_mo33.cube'));
    assert.strictEqual(r.states.length, 2);
    assert.ok(Math.abs(r.states[1].wavelengthNm - 338.5) < 0.2);
  });

  it('builds isosurface meshes of both signs', () => {
    const r = host.methods.isosurface({ path: path.join(ws, 'trans_mo33.cube'), iso: 0.05 }, ctx) as IsoResult;
    assert.ok(r.positive.indices.length > 0 && r.negative.indices.length > 0);
    assert.strictEqual(r.positive.positions.length, r.positive.normals.length);
    assert.strictEqual(r.iso, 0.05);
  });

  it('writes a %plots block like photoswitch 06-orbitals/*.inp', () => {
    assert.strictEqual(plotsBlock('cis', [29, 33]), [
      '%plots', '  dim1 50 dim2 50 dim3 50', '  Format Gaussian_Cube', '  MO("cis_mo29.cube",29,0);', '  MO("cis_mo33.cube",33,0);', 'end'
    ].join('\n'));
  });

  it('rejects paths outside the workspace', () => {
    assert.throws(() => host.methods.open({ path: path.join(os.tmpdir(), 'nope', 'x.xyz') }, ctx), /outside the workspace/);
    assert.throws(() => host.methods.open({ path: 42 }, ctx), /Expected a file path/);
  });
});
