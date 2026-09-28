import * as assert from 'assert';
import { lintDocument } from '../src/diagnostics';
import { __resetConfig, __setConfig, DiagnosticSeverity } from './mocks/vscode';
import { makeDoc, makeCollection } from './helpers/fakeDocument';

// lintDocument reads `orcaInp.diagnostics.*` settings via
// vscode.workspace.getConfiguration -- reset between tests so one test's
// overrides can't leak into the next.
beforeEach(() => {
  __resetConfig();
});

function lint(lines: string[]) {
  const doc = makeDoc(lines);
  const collection = makeCollection();
  lintDocument(doc as any, collection as any);
  return (collection.diagnostics || []) as { message: string; severity: DiagnosticSeverity }[];
}

describe('lintDocument: clean input', () => {
  it('produces no diagnostics for a well-formed, balanced file', () => {
    const diags = lint([
      '! HF def2-SVP',
      '%pal nprocs 4',
      'end',
      '* xyz 0 1',
      'C 0 0 0',
      '*'
    ]);
    assert.deepStrictEqual(diags, []);
  });
});

describe('lintDocument: %block / end balance', () => {
  it('flags a %block that is never closed', () => {
    const diags = lint([
      '! HF',
      '%pal nprocs 4',
      '* xyz 0 1',
      'C 0 0 0',
      '*'
    ]);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /never closed with "end"/);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
  });

  it('flags a stray "end" with no matching %block', () => {
    const diags = lint([
      '! HF',
      'end',
      '* xyz 0 1',
      'C 0 0 0',
      '*'
    ]);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /no matching "%block"/);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
  });

  it('does not treat "end" inside a comment as a real block terminator', () => {
    const diags = lint([
      '# notes: end of section',
      '! HF',
      '* xyz 0 1',
      'C 0 0 0',
      '*'
    ]);
    assert.deepStrictEqual(diags, []);
  });
});

describe('lintDocument: coordinate block balance', () => {
  it('flags a coordinate block that is never closed', () => {
    const diags = lint([
      '! HF',
      '* xyz 0 1',
      'C 0 0 0'
    ]);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /never closed with a trailing "\*"/);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
  });

  it('flags an incomplete coordinate header (missing charge/multiplicity)', () => {
    const diags = lint([
      '! HF',
      '* xyz',
      'C 0 0 0',
      '*'
    ]);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /looks incomplete/);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Warning);
  });

  it('skips block/keyword checks for lines inside a coordinate block', () => {
    // "end" here is a stray atom label, not a %block terminator.
    const diags = lint([
      '! HF',
      '* xyz 0 1',
      'end 0 0 0',
      '*'
    ]);
    assert.deepStrictEqual(diags, []);
  });
});

describe('lintDocument: unknown simple-input keywords', () => {
  it('flags an unrecognized keyword on a "!" line at the configured severity', () => {
    const diags = lint([
      '! HF NOTAREALKEYWORD def2-SVP',
      '* xyz 0 1',
      'C 0 0 0',
      '*'
    ]);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /Unrecognized keyword "NOTAREALKEYWORD"/);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Warning);
  });

  it('honors unknownKeywordSeverity=off by suppressing the diagnostic', () => {
    __setConfig('orcaInp', { 'diagnostics.unknownKeywordSeverity': 'off' });
    const diags = lint([
      '! HF NOTAREALKEYWORD def2-SVP',
      '* xyz 0 1',
      'C 0 0 0',
      '*'
    ]);
    assert.deepStrictEqual(diags, []);
  });

  it('maps unknownKeywordSeverity=error to DiagnosticSeverity.Error', () => {
    __setConfig('orcaInp', { 'diagnostics.unknownKeywordSeverity': 'error' });
    const diags = lint([
      '! NOTAREALKEYWORD',
      '* xyz 0 1',
      'C 0 0 0',
      '*'
    ]);
    assert.strictEqual(diags.length, 1);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Error);
  });
});

describe('lintDocument: diagnostics.enable setting', () => {
  it('clears diagnostics for the document instead of computing them when disabled', () => {
    __setConfig('orcaInp', { 'diagnostics.enable': false });
    const doc = makeDoc(['! HF NOTAREALKEYWORD', 'end']); // would otherwise flag 2 issues
    const collection = makeCollection();
    lintDocument(doc as any, collection as any);
    assert.strictEqual(collection.wasDeleted, true);
    assert.strictEqual(collection.diagnostics, null);
  });
});

describe('lintDocument: sanity heads-up diagnostics', () => {
  it('warns when there is no simple-input ("!") line at all', () => {
    const diags = lint(['* xyz 0 1', 'C 0 0 0', '*']);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /No simple-input line/);
    assert.strictEqual(diags[0].severity, DiagnosticSeverity.Information);
  });

  it('warns when there is a simple-input line but no coordinate block', () => {
    const diags = lint(['! HF def2-SVP']);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /No coordinate block/);
  });

  it('does not warn about a missing "!" line for an empty document', () => {
    const diags = lint(['']);
    assert.deepStrictEqual(diags, []);
  });
});

describe('lintDocument: one-line directives and xyzfile', () => {
  it('accepts %maxcore and a one-line "* xyzfile" header', () => {
    const diags = lint([
      '! DLPNO-CCSD(T) def2-TZVPP def2-TZVPP/C',
      '',
      '%pal',
      '  nprocs 8',
      'end',
      '',
      '%maxcore 4000',
      '',
      '* xyzfile 0 1 prod.xyz',
      ''
    ]);
    assert.deepStrictEqual(diags, []);
  });

  it('accepts a %block ... end on one line', () => {
    const diags = lint(['! HF def2-SVP', '%pal nprocs 4 end', '* xyz 0 1', 'C 0 0 0', '*']);
    assert.deepStrictEqual(diags, []);
  });

  it('warns about "* xyzfile" without a file name', () => {
    const diags = lint(['! HF def2-SVP', '* xyzfile 0 1']);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /Incomplete header/);
  });
});

describe('lintDocument: nested sub-blocks', () => {
  it('accepts %geom Constraints ... end ... end', () => {
    const diags = lint(['! Opt', '%geom', '  Constraints', '    { B 0 1 C }', '  end', 'end', '* xyz 0 1', 'C 0 0 0', '*']);
    assert.deepStrictEqual(diags, []);
  });

  it('flags a %geom whose Constraints sub-block is closed but the block is not', () => {
    const diags = lint(['! Opt', '%geom', '  Constraints', '    { B 0 1 C }', '  end', '* xyz 0 1', 'C 0 0 0', '*']);
    assert.strictEqual(diags.length, 1);
    assert.match(diags[0].message, /%geom/);
  });
});

describe('lintDocument: value and end on one line', () => {
  it('accepts "nprocs 4 end" inside %pal and a one-line Constraints inside %geom', () => {
    const diags = lint([
      '! Opt CHELPG CPCMX(methanol)', '%pal', '  nprocs 4 end   # comment', '%geom', '  Constraints { B 0 1 C } end', 'end',
      '* xyz 0 1', 'C 0 0 0', '*'
    ]);
    assert.deepStrictEqual(diags, []);
  });
});
