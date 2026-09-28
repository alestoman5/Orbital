import * as assert from 'assert';
import { OrcaCompletionProvider } from '../src/completion';
import { Position } from './mocks/vscode';
import { makeDoc } from './helpers/fakeDocument';
import {
  RUNTYPE_KEYWORDS, WAVEFUNCTION_METHOD_KEYWORDS, DFT_FUNCTIONAL_KEYWORDS,
  BASIS_KEYWORDS, AUX_BASIS_KEYWORDS, ECP_KEYWORDS, RELATIVISTIC_KEYWORDS,
  NEB_KEYWORDS, ALGORITHMIC_KEYWORDS, MISC_STRUCTURE_KEYWORDS,
  BLOCK_NAMES, BLOCK_OPTIONS, BLOCK_OPTIONS_BY_BLOCK, BLOCK_DOCS, KEYWORD_DOCS
} from '../src/keywords';

const provider = new OrcaCompletionProvider();

describe('OrcaCompletionProvider: "!" simple-input line', () => {
  it('offers every simple-input keyword category, with no filtering by what was typed', () => {
    const doc = makeDoc(['! ']);
    const items = provider.provideCompletionItems(doc as any, new Position(0, 2) as any);
    const expectedLength = RUNTYPE_KEYWORDS.length + WAVEFUNCTION_METHOD_KEYWORDS.length +
      DFT_FUNCTIONAL_KEYWORDS.length + BASIS_KEYWORDS.length + AUX_BASIS_KEYWORDS.length +
      ECP_KEYWORDS.length + RELATIVISTIC_KEYWORDS.length + NEB_KEYWORDS.length +
      ALGORITHMIC_KEYWORDS.length + MISC_STRUCTURE_KEYWORDS.length;
    assert.strictEqual(items.length, expectedLength);
  });

  it('tags each item with its category detail and attaches known documentation', () => {
    const doc = makeDoc(['! ']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(0, 2) as any);

    const hf = items.find(i => i.label === 'HF');
    assert.ok(hf, 'expected an "HF" completion item');
    assert.strictEqual(hf.detail, 'ORCA wavefunction method');

    const sp = items.find(i => i.label === 'SP');
    assert.ok(sp, 'expected an "SP" completion item');
    assert.strictEqual(sp.detail, 'ORCA runtype keyword');
    assert.strictEqual(sp.documentation.value, KEYWORD_DOCS['SP']);
  });
});

describe('OrcaCompletionProvider: "%" block-name line', () => {
  it('offers every block name once, with documentation where available', () => {
    const doc = makeDoc(['%']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(0, 1) as any);
    assert.strictEqual(items.length, BLOCK_NAMES.length);

    const pal = items.find(i => i.label === 'pal');
    assert.ok(pal);
    assert.strictEqual(pal.documentation.value, BLOCK_DOCS['pal']);
  });
});

describe('OrcaCompletionProvider: inside an open %block ... end region', () => {
  it('offers the generic block options for a block without a curated option list', () => {
    const doc = makeDoc(['%plots', 'dim1 40']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(1, 7) as any);
    assert.strictEqual(items.length, BLOCK_OPTIONS.length);
    assert.ok(items.some(i => i.label === 'nprocs'));
  });

  it('offers only that block\'s own options for curated blocks', () => {
    const doc = makeDoc(['%pal', 'nprocs 4']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(1, 8) as any);
    assert.deepStrictEqual(items.map(i => i.label), BLOCK_OPTIONS_BY_BLOCK['pal'].map(o => o.name));
  });

  it('offers %geom options (not %tddft ones) inside %geom, with documentation', () => {
    const doc = makeDoc(['! PBE def2-SVP OptTS', '%geom', '  ']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(2, 2) as any);
    const labels = items.map(i => i.label);
    assert.ok(labels.includes('Calc_Hess'));
    assert.ok(!labels.includes('NRoots'));
    const calcHess = items.find(i => i.label === 'Calc_Hess');
    assert.strictEqual(calcHess.detail, '%geom option');
    assert.ok(calcHess.documentation.value.length > 0);
  });

  it('still knows it is inside %geom after a closed Constraints sub-block', () => {
    const doc = makeDoc(['%geom', '  Constraints', '    { B 0 1 C }', '  end', '  ']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(4, 2) as any);
    assert.ok(items.some(i => i.label === 'Calc_Hess'));
  });

  it('treats %cis as a synonym of %tddft', () => {
    const doc = makeDoc(['%cis', '  ']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(1, 2) as any);
    assert.ok(items.some(i => i.label === 'NRoots'));
  });

  it('ignores one-line blocks above the cursor', () => {
    const doc = makeDoc(['%pal nprocs 4 end', '  ']);
    const items = provider.provideCompletionItems(doc as any, new Position(1, 2) as any);
    assert.deepStrictEqual(items, []);
  });

  it('does not offer block options once the block has been closed', () => {
    const doc = makeDoc(['%pal', 'nprocs 4', 'end', 'foo']);
    const items = provider.provideCompletionItems(doc as any, new Position(3, 3) as any);
    assert.deepStrictEqual(items, []);
  });
});

describe('OrcaCompletionProvider: "*" coordinate-block header', () => {
  it('offers the coordinate block type keywords', () => {
    const doc = makeDoc(['*']);
    const items: any[] = provider.provideCompletionItems(doc as any, new Position(0, 1) as any);
    const labels = items.map(i => i.label).sort();
    assert.deepStrictEqual(labels, ['gzmt', 'int', 'xyz', 'xyzfile'].sort());
  });
});

describe('OrcaCompletionProvider: no recognized context', () => {
  it('offers nothing on a plain line outside any block/simple-input/coordinate context', () => {
    const doc = makeDoc(['some random line']);
    const items = provider.provideCompletionItems(doc as any, new Position(0, 17) as any);
    assert.deepStrictEqual(items, []);
  });
});
