// Parity of buildNeaCommand with the interactive neaCommand of
// src/features/neaRuns.ts: neaCommand is driven through a scripted stand-in
// for the vscode UI calls it makes, and the command it proposes in the input
// box is compared with buildNeaCommand for the same choices.

import * as assert from 'assert';
import * as path from 'path';
import * as vscodeMock from '../mocks/vscode';
import { buildNeaCommand, NeaCommandOptions, shellQuote } from '../../src/inputs';

const mock = vscodeMock as unknown as Record<string, any>;

class FakeUri {
  constructor(public fsPath: string) {}
  static file(p: string) {
    return new FakeUri(p);
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

/** Runs neaCommand with scripted quick-pick answers; returns the proposed command. */
async function neaCommandProposal(scriptsDir: string, picks: string[], inputs: string[]): Promise<string | undefined> {
  const saved = { window: mock.window, Uri: mock.Uri };
  let proposed: string | undefined;
  const answers = [...picks];
  mock.Uri = FakeUri;
  mock.window = {
    showQuickPick: async (items: (string | { label: string })[]) => {
      const want = answers.shift();
      return items.find(i => (typeof i === 'string' ? i : i.label) === want);
    },
    showInputBox: async (o: { value: string }) => {
      proposed = o.value;
      return undefined; // cancel: no terminal
    },
    showErrorMessage: (m: string) => assert.fail(m),
    showOpenDialog: async () => assert.fail('unexpected open dialog')
  };
  vscodeMock.__setConfig('orcaInp', { 'nea.scriptsDir': scriptsDir });
  try {
    const { neaCommand } = await import('../../src/features/neaRuns');
    const uris = inputs.map(p => new FakeUri(p));
    await neaCommand(uris[0] as any, uris as any);
  } finally {
    mock.window = saved.window;
    mock.Uri = saved.Uri;
    vscodeMock.__resetConfig();
  }
  return proposed;
}

describe('inputs: buildNeaCommand', () => {
  const root = path.resolve('/work/uv-vis');
  const scripts = path.join(root, 'scripts');
  const mol = path.join(root, 'molecules', 'ch2oo.molden');

  const cases: { name: string; picks: string[]; opts: NeaCommandOptions }[] = [
    {
      name: 'from_geometry wigner',
      picks: ['from_geometry.py', 'wigner'],
      opts: { script: 'from_geometry.py', root, inputs: [mol], sampling: 'wigner' }
    },
    {
      name: 'from_geometry md',
      picks: ['from_geometry.py', 'md'],
      opts: { script: 'from_geometry.py', root, inputs: [path.join(root, 'md', 'traj.xyz')], sampling: 'md' }
    },
    {
      name: 'from_ensemble',
      picks: ['from_ensemble.py'],
      opts: { script: 'from_ensemble.py', root, inputs: [path.join(root, 'ens', 'ensemble.xyz')] }
    },
    {
      name: 'compare_ensembles with a path that needs quoting',
      picks: ['compare_ensembles.py'],
      opts: {
        script: 'compare_ensembles.py', root,
        inputs: [path.join(root, 'runs', 'a set'), path.join(root, "it's.xyz")]
      }
    }
  ];

  for (const c of cases) {
    it(`reproduces neaCommand: ${c.name}`, async () => {
      const expected = await neaCommandProposal(scripts, c.picks, c.opts.inputs);
      assert.ok(expected, 'neaCommand proposed a command');
      assert.strictEqual(buildNeaCommand(c.opts), expected);
    });
  }

  it('builds the documented default command', () => {
    const cmd = buildNeaCommand({ script: 'from_geometry.py', root, inputs: [mol], sampling: 'wigner' });
    assert.strictEqual(cmd, [
      'python scripts/from_geometry.py', path.relative(root, mol).split(path.sep).join('/'), // always forward slashes: the command runs in a POSIX shell
      '--sampling wigner -n 1000 --sample-method PBE --sample-basis aug-cc-pVDZ -T 300',
      "-o runs/ch2oo_wigner --method 'adc(3)' --basis aug-cc-pVDZ --nstates 2 -j 30"
    ].join(' '));
  });

  it('takes overrides', () => {
    const cmd = buildNeaCommand({
      script: 'from_ensemble.py', root, inputs: [path.join(root, 'e.xyz')],
      method: 'adc(2)', basis: 'def2-SVPD', nstates: 5, jobs: 8, outDir: 'runs/my run'
    });
    assert.strictEqual(cmd, "python scripts/from_ensemble.py e.xyz -o 'runs/my run' --method 'adc(2)' --basis def2-SVPD --nstates 5 -j 8");
  });

  it('quotes like a POSIX shell', () => {
    assert.strictEqual(shellQuote('a/b-c.xyz'), 'a/b-c.xyz');
    assert.strictEqual(shellQuote('a b'), "'a b'");
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
  });
});
