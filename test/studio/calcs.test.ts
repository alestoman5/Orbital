import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { createCalcsHost, isInside, timeStats } from '../../src/studio/tabs/calcs/host';
import type { GroupDetail, ProblemsResult, ScanResult } from '../../src/studio/tabs/calcs/types';
import { expandBraces, globToRegExp, matchesAny, mergeGlobs } from '../../src/studio/tabs/runs/glob';

const FIX = path.resolve(__dirname, '..', 'fixtures', 'calcs');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

interface Fake extends HostContext {
  posts: [string, unknown][];
  watchers: ((p: string) => void)[];
  finds: number;
}

function fakeContext(root: string, settings: Record<string, unknown> = {}): Fake {
  const ctx: Fake = {
    posts: [],
    watchers: [],
    finds: 0,
    tab: 'calcs',
    extensionPath: '.',
    workspaceFolders: () => [root],
    storageDir: () => undefined,
    config: <T>(k: string, fallback: T) => (k in settings ? (settings[k] as T) : fallback),
    async findFiles(include, options = {}) {
      ctx.finds++;
      const base = options.base ?? root;
      const re = globToRegExp(include);
      return walk(base).filter(f => re.test(path.relative(base, f).split(path.sep).join('/'))).sort();
    },
    watch(_include, onChange) {
      ctx.watchers.push(onChange);
      return { dispose() {} };
    },
    post: (name, payload) => ctx.posts.push([name, payload]),
    navigate: () => undefined,
    saveFile: async () => undefined,
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    log: () => undefined
  };
  return ctx;
}

const GLOBS = { 'studio.calcGlobs': ['**/result.json', '**/*.out', '**/*.json'] };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('studio calcs host', () => {
  it('scans groups of the fixture tree with totals and progress events', async () => {
    const host = createCalcsHost();
    const ctx = fakeContext(FIX, GLOBS);
    const r = (await host.methods.scan({}, ctx)) as ScanResult;
    assert.deepStrictEqual(r.groups.map(g => `${g.kind} ${g.label}`), ['pyscf-result ens/geoms', 'json misc', 'orca-out orca']);
    const ens = r.groups[0];
    assert.strictEqual(ens.total, 5);
    assert.deepStrictEqual([ens.counts.ok, ens.counts['not converged'], ens.counts.unreadable, ens.counts['not started']], [2, 1, 1, 1]);
    assert.deepStrictEqual([ens.method, ens.basis], ['adc(3)', 'aug-cc-pVDZ']);
    assert.strictEqual(ens.id, `pyscf-result:${path.join(FIX, 'ens', 'geoms')}`);
    assert.strictEqual(r.totals.total, r.groups.reduce((n, g) => n + g.total, 0));
    assert.strictEqual(r.cached, false);
    assert.ok(r.parsed > 0);
    assert.ok(ctx.posts.some(([n, p]) => n === 'progress' && (p as { phase: string }).phase === 'listing'));
  });

  it('returns the previous result until a watched file changes', async () => {
    const host = createCalcsHost({ debounceMs: 5 });
    const ctx = fakeContext(FIX, GLOBS);
    host.activate!(ctx);
    await host.methods.scan({}, ctx);
    const finds = ctx.finds;
    const again = (await host.methods.scan({}, ctx)) as ScanResult;
    assert.strictEqual(again.cached, true);
    assert.strictEqual(ctx.finds, finds, 'no re-listing');
    ctx.watchers[0](path.join(FIX, 'orca', 'opt_ok.out'));
    await wait(30);
    assert.ok(ctx.posts.some(([n]) => n === 'changed'));
    const fresh = (await host.methods.scan({}, ctx)) as ScanResult;
    assert.strictEqual(fresh.cached, false);
    assert.strictEqual(fresh.parsed, 0, 'unchanged files come from the cache');
    assert.strictEqual(ctx.finds, finds, 'the file list is kept from watcher events');
    const forced = (await host.methods.scan({ refresh: true }, ctx)) as ScanResult;
    assert.ok(ctx.finds > finds, 'refresh re-lists');
    assert.strictEqual(forced.fileCount, fresh.fileCount);
  });

  it('adds and drops files reported by the watcher', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-calcs-'));
    try {
      fs.mkdirSync(path.join(tmp, 'a'));
      fs.writeFileSync(path.join(tmp, 'a', 'x.json'), '{"converged": true, "time_total_s": 5}');
      const host = createCalcsHost({ debounceMs: 1 });
      const ctx = fakeContext(tmp, GLOBS);
      host.activate!(ctx);
      let r = (await host.methods.scan({}, ctx)) as ScanResult;
      assert.strictEqual(r.totals.total, 1);
      const y = path.join(tmp, 'a', 'y.json');
      fs.writeFileSync(y, '{"converged": false}');
      ctx.watchers[0](y);
      await wait(20);
      r = (await host.methods.scan({}, ctx)) as ScanResult;
      assert.deepStrictEqual([r.totals.total, r.totals.counts['not converged']], [2, 1]);
      fs.unlinkSync(y);
      ctx.watchers[0](y);
      await wait(20);
      r = (await host.methods.scan({}, ctx)) as ScanResult;
      assert.strictEqual(r.totals.total, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('scopes to a folder and rejects folders outside the workspace', async () => {
    const host = createCalcsHost();
    const ctx = fakeContext(FIX, GLOBS);
    const r = (await host.methods.scan({ scope: path.join(FIX, 'orca') }, ctx)) as ScanResult;
    assert.deepStrictEqual(r.groups.map(g => g.label), ['orca']);
    assert.strictEqual(r.scope, path.join(FIX, 'orca'));
    await assert.rejects(async () => host.methods.scan({ scope: os.tmpdir() }, ctx), /outside the workspace/);
    const all = (await host.methods.scan({ extraFolders: [os.tmpdir()] }, ctx)) as ScanResult;
    assert.deepStrictEqual(all.skipped, [path.resolve(os.tmpdir())]);
  });

  it('accepts picked folders outside the workspace', async () => {
    const host = createCalcsHost();
    const ctx = fakeContext(path.join(FIX, 'misc'), GLOBS);
    ctx.pickFiles = async () => [path.join(FIX, 'orca')];
    const picked = (await host.methods.addFolder({}, ctx)) as string[];
    assert.deepStrictEqual(picked, [path.join(FIX, 'orca')]);
    const r = (await host.methods.scan({ extraFolders: picked }, ctx)) as ScanResult;
    assert.deepStrictEqual(r.groups.map(g => g.label), ['misc', 'orca']);
  });

  it('serves group details, filtered problems and the failed list', async () => {
    const host = createCalcsHost();
    const ctx = fakeContext(FIX, GLOBS);
    const r = (await host.methods.scan({}, ctx)) as ScanResult;
    const ens = r.groups.find(g => g.kind === 'pyscf-result')!;
    const d = (await host.methods.group({ id: ens.id }, ctx)) as GroupDetail;
    assert.strictEqual(d.config?.method, 'adc(3)');
    assert.strictEqual(d.config?.command, 'python scripts/from_ensemble.py');
    assert.strictEqual(d.times?.n, 2);
    assert.strictEqual(d.times!.values.reduce((a, b) => a + b, 0), 2);
    assert.deepStrictEqual(d.problems.items.map(i => `${i.name} ${i.status}`), ['geom_0002 not converged', 'geom_0003 unreadable', 'geom_0004 not started']);
    assert.strictEqual(d.problems.items[0].detail, 'SCF did not converge');
    // PySCF items open run.log when there is one.
    assert.ok(d.problems.items[2].path.endsWith('run.log'));
    const only = (await host.methods.problems({ id: ens.id, status: 'unreadable' }, ctx)) as ProblemsResult;
    assert.deepStrictEqual(only.items.map(i => i.name), ['geom_0003']);
    const capped = (await host.methods.problems({ id: ens.id, limit: 1 }, ctx)) as ProblemsResult;
    assert.deepStrictEqual([capped.items.length, capped.total], [1, 3]);
    assert.strictEqual(await host.methods.failedList({ id: ens.id }, ctx), 'geom_0002\ngeom_0003\ngeom_0004');
    assert.throws(() => host.methods.group({ id: 'json:/nowhere' }, ctx), /scan first/);
    assert.throws(() => host.methods.group({ id: '../etc' }, ctx), /group id/);
    assert.throws(() => host.methods.problems({ id: ens.id, status: 'bogus' }, ctx), /unknown status/);
  });

  it('computes time stats and a histogram', () => {
    const t = timeStats([1, 2, 3, 4, 100])!;
    assert.deepStrictEqual([t.n, t.min, t.median, t.max], [5, 1, 3, 100]);
    assert.strictEqual(t.edges.length, t.values.length + 1);
    assert.strictEqual(t.values.reduce((a, b) => a + b, 0), 5);
    assert.strictEqual(timeStats([]), undefined);
    const one = timeStats([42])!;
    assert.ok(one.edges[0] < 42 && one.edges[one.edges.length - 1] > 42);
  });

  it('isInside handles equal, nested and sibling paths', () => {
    assert.ok(isInside(path.join(FIX, 'a'), FIX));
    assert.ok(isInside(FIX, FIX));
    assert.ok(!isInside(`${FIX}-other`, FIX));
  });
});

describe('studio glob helpers', () => {
  it('expands braces, nested too', () => {
    assert.deepStrictEqual(expandBraces('**/{node_modules,.git}/**'), ['**/node_modules/**', '**/.git/**']);
    assert.deepStrictEqual(expandBraces('a{b,{c,d}}e'), ['abe', 'ace', 'ade']);
    assert.deepStrictEqual(expandBraces('plain'), ['plain']);
  });

  it('merges globs into one brace pattern', () => {
    assert.strictEqual(mergeGlobs(['**/{node_modules,.git}/**', '**/geom_*/**']), '{**/node_modules/**,**/.git/**,**/geom_*/**}');
    assert.strictEqual(mergeGlobs(['x']), 'x');
    assert.strictEqual(mergeGlobs([]), undefined);
  });

  it('matches globs against relative paths', () => {
    assert.ok(globToRegExp('**/*.log').test('a/b/run.log'));
    assert.ok(globToRegExp('**/*.log').test('run.log'));
    assert.ok(!globToRegExp('*.log').test('a/run.log'));
    assert.ok(globToRegExp('**/output').test('x/output'));
    assert.ok(matchesAny('ens/geom_0001/run.log', ['**/geom_*/**']));
    assert.ok(!matchesAny('ens/pipeline.log', ['**/geom_*/**']));
    assert.ok(matchesAny('node_modules', ['**/{node_modules,.git}/**']));
    assert.ok(globToRegExp('geom_[0-9]*').test('geom_1'));
  });
});
