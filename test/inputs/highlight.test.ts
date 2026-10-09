import * as assert from 'assert';
import { TEMPLATES, Token, buildOrcaInput, buildPyscfScript, tokenizeOrca, tokenizePython } from '../../src/inputs';

const join = (t: Token[]) => t.map(x => x.text).join('');
const kinds = (t: Token[], kind: string) => t.filter(x => x.kind === kind).map(x => x.text);

describe('inputs: tokenizeOrca', () => {
  const text = [
    '# title',
    '! PBE0 def2-SVP D3BJ Opt   # inline comment',
    '%pal nprocs 4 end',
    '%maxcore 2000',
    '%geom',
    '  Scan',
    '    B 0 1 = 0.9, 1.3, 9',
    '  end',
    'end',
    '%cpcm',
    '  SMDSolvent "water"',
    '  SMD true',
    'end',
    '* xyz 0 1',
    'O   0.0  0.0  0.1173',
    'H   0.0  0.7572 -0.4692',
    '*',
    '* xyzfile 0 1 mol.xyz'
  ].join('\n');
  const tokens = tokenizeOrca(text);

  it('is lossless', () => {
    assert.strictEqual(join(tokens), text);
    for (const t of TEMPLATES.filter(x => x.programs.includes('orca'))) {
      const inp = buildOrcaInput(t.build()).text;
      assert.strictEqual(join(tokenizeOrca(inp)), inp, t.id);
    }
  });

  it('classifies comments, keywords, blocks, options, numbers, strings and elements', () => {
    assert.deepStrictEqual(kinds(tokens, 'comment'), ['# title', '# inline comment']);
    assert.deepStrictEqual(kinds(tokens, 'keyword').slice(0, 4), ['PBE0', 'def2-SVP', 'D3BJ', 'Opt']);
    assert.ok(kinds(tokens, 'keyword').includes('true'));
    assert.ok(kinds(tokens, 'keyword').includes('xyzfile'));
    for (const b of ['%', 'pal', 'maxcore', 'geom', 'end', 'cpcm']) {
      assert.ok(kinds(tokens, 'block').includes(b), b);
    }
    assert.ok(kinds(tokens, 'option').includes('nprocs'));
    assert.ok(kinds(tokens, 'option').includes('SMDSolvent'));
    assert.deepStrictEqual(kinds(tokens, 'string'), ['"water"', 'mol.xyz']);
    assert.deepStrictEqual(kinds(tokens, 'element'), ['O', 'H']);
    assert.ok(kinds(tokens, 'number').includes('-0.4692'));
    assert.ok(kinds(tokens, 'number').includes('2000'));
  });

  it('marks unknown "!" keywords as plain text', () => {
    assert.deepStrictEqual(kinds(tokenizeOrca('! B3LYP Foo'), 'text'), ['Foo']);
  });
});

describe('inputs: tokenizePython', () => {
  const src = [
    '#!/usr/bin/env python3',
    '"""doc',
    'string"""',
    'import os',
    'def main(a=1.5e-3):',
    '    s = f"x {a}" + \'y\'  # note',
    '    print(len(s), None)',
    ''
  ].join('\n');
  const tokens = tokenizePython(src);

  it('is lossless on hand-written and generated code', () => {
    assert.strictEqual(join(tokens), src);
    for (const t of TEMPLATES.filter(x => x.programs.includes('pyscf'))) {
      const py = buildPyscfScript(t.build()).text;
      assert.strictEqual(join(tokenizePython(py)), py, t.id);
    }
  });

  it('classifies tokens', () => {
    assert.deepStrictEqual(kinds(tokens, 'comment'), ['#!/usr/bin/env python3', '# note']);
    assert.deepStrictEqual(kinds(tokens, 'string'), ['"""doc\nstring"""', 'f"x {a}"', "'y'"]);
    assert.deepStrictEqual(kinds(tokens, 'keyword'), ['import', 'def', 'None']);
    assert.deepStrictEqual(kinds(tokens, 'function'), ['main']);
    assert.deepStrictEqual(kinds(tokens, 'builtin'), ['print', 'len']);
    assert.deepStrictEqual(kinds(tokens, 'number'), ['1.5e-3']);
  });

  it('keeps an unterminated triple-quoted string to the end', () => {
    const t = tokenizePython('x = """open\nstill');
    assert.strictEqual(t[t.length - 1].kind, 'string');
    assert.strictEqual(join(t), 'x = """open\nstill');
  });
});
