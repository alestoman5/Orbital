import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CalcCache, CalcGroup, groupsFromFiles, orcaCalcStatus, readCalcGroups, summarizeGroup } from '../../src/chem/calcStatus';
import { readGeomSet } from '../../src/chem/neaRun';

// Fixture tree test/fixtures/calcs:
//   ens/run_config.json, ens/geoms/geom_000N (ok + run.log, not converged with failure,
//     broken JSON, no result.json, ok with only time_scf_s/time_eom_s)
//   orca/*.out: opt_ok, running and the head of scf_fail/opt_maxiter are cut from a real
//     ORCA 6.1.1 TightOpt Freq output; the failure banners are constructed. slurm-123.out is
//     not ORCA, empty.out is empty.
//   misc/*.json: converged true/false, no converged key, a JSON array.
const ROOT = path.join(__dirname, '..', 'fixtures', 'calcs');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(json|out)$/.test(e.name) ? [p] : [];
  });
}

function byLabel(groups: CalcGroup[], label: string): CalcGroup {
  const g = groups.find(x => x.label === label);
  assert.ok(g, `group ${label} in ${groups.map(x => x.label).join(', ')}`);
  return g!;
}

describe('chem/calcStatus', () => {
  const files = walk(ROOT);

  it('classifies a PySCF geom_NNNN set like readGeomSet, with times, details and run.log paths', () => {
    const groups = groupsFromFiles(files, ROOT);
    const g = byLabel(groups, 'ens/geoms');
    assert.strictEqual(g.kind, 'pyscf-result');
    const status = Object.fromEntries(g.items.map(i => [i.name, i.status]));
    assert.deepStrictEqual(status, {
      geom_0001: 'ok', geom_0002: 'not converged', geom_0003: 'unreadable', geom_0004: 'not started', geom_0010: 'ok'
    });
    const ref = readGeomSet(g.dir);
    for (const s of ['ok', 'not converged', 'unreadable', 'not started'] as const) {
      assert.strictEqual(g.counts[s], ref.byStatus[s].length, s);
    }
    assert.deepStrictEqual(g.items.map(i => i.name), ['geom_0001', 'geom_0002', 'geom_0003', 'geom_0004', 'geom_0010']);
    assert.strictEqual(g.items[0].path, path.join(g.dir, 'geom_0001', 'run.log'));
    assert.strictEqual(g.items[1].path, path.join(g.dir, 'geom_0002', 'result.json'));
    assert.strictEqual(g.items[3].path, path.join(g.dir, 'geom_0004', 'run.log'));
    assert.strictEqual(g.items[0].timeS, 95.3);
    assert.strictEqual(g.items[4].timeS, 1.5, 'first time_*_s key when time_adc_s is missing');
    assert.strictEqual(g.items[1].detail, 'SCF did not converge');
    assert.deepStrictEqual(g.times, [1.5, 95.3]);
    assert.strictEqual(g.config?.basis, 'aug-cc-pVDZ', 'run_config.json of the parent');
    const s = summarizeGroup(g);
    assert.strictEqual(s.total, 5);
    assert.strictEqual(s.okFrac, 0.4);
    assert.strictEqual(s.medianTimeS, 95.3, 'times[n // 2] as v_status.py');
    assert.strictEqual(s.maxTimeS, 95.3);
    assert.deepStrictEqual(s.problems.map(p => p.name), ['geom_0002', 'geom_0003', 'geom_0004']);
  });

  it('classifies ORCA outputs', () => {
    const g = byLabel(groupsFromFiles(files, ROOT), 'orca');
    assert.strictEqual(g.kind, 'orca-out');
    const by = Object.fromEntries(g.items.map(i => [i.name, i]));
    assert.strictEqual(by['opt_ok.out'].status, 'ok');
    assert.strictEqual(by['opt_ok.out'].timeS, 125.467);
    assert.strictEqual(by['opt_ok.out'].detail, 'ok');
    assert.strictEqual(by['opt_maxiter.out'].status, 'not converged');
    assert.match(by['opt_maxiter.out'].detail!, /optimization not converged/);
    assert.strictEqual(by['scf_fail.out'].status, 'not converged');
    assert.match(by['scf_fail.out'].detail!, /SCF not converged/);
    assert.strictEqual(by['running.out'].status, 'running');
    assert.strictEqual(by['empty.out'].status, 'unreadable');
    assert.strictEqual(by['slurm-123.out'].status, 'unreadable');
    assert.strictEqual(by['slurm-123.out'].detail, 'not an ORCA output');
    assert.strictEqual(orcaCalcStatus('* O   R   C   A *\n\n ... aborting the run\n').status, 'error');
    assert.deepStrictEqual(g.times, [125.467]);
  });

  it('groups other JSON files with a boolean converged key', () => {
    const groups = groupsFromFiles(files, ROOT);
    const g = byLabel(groups, 'misc');
    assert.strictEqual(g.kind, 'json');
    assert.deepStrictEqual(g.items.map(i => [i.name, i.status, i.timeS]), [['opt_a.json', 'ok', 7], ['opt_b.json', 'not converged', undefined]]);
    assert.ok(!groups.some(x => x.label === 'ens'), 'run_config.json is not an item');
    assert.deepStrictEqual(groups.map(x => x.label), ['ens/geoms', 'misc', 'orca']);
  });

  it('re-parses only changed files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calcs-'));
    try {
      fs.cpSync(ROOT, tmp, { recursive: true });
      const list = walk(tmp);
      const cache = new CalcCache();
      readCalcGroups(tmp, list, cache);
      assert.strictEqual(cache.stats.reused, 0);
      const parsed = cache.stats.parsed;
      readCalcGroups(tmp, list, cache);
      assert.deepStrictEqual(cache.stats, { parsed: 0, reused: parsed });
      const f = path.join(tmp, 'ens', 'geoms', 'geom_0003', 'result.json');
      fs.writeFileSync(f, JSON.stringify({ converged: true, time_adc_s: 50 }));
      fs.utimesSync(f, new Date(), new Date(Date.now() + 10000));
      fs.writeFileSync(path.join(tmp, 'ens', 'geoms', 'geom_0004', 'result.json'), '{"converged": false}');
      const g = byLabel(readCalcGroups(tmp, walk(tmp), cache), 'ens/geoms');
      assert.deepStrictEqual(cache.stats, { parsed: 2, reused: parsed - 1 });
      assert.deepStrictEqual(g.counts, { ok: 3, 'not converged': 2, error: 0, running: 0, unreadable: 0, 'not started': 0 });
      // entries of files that are gone are pruned
      readCalcGroups(tmp, [], cache);
      assert.strictEqual(cache.json.size + cache.orca.size, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
