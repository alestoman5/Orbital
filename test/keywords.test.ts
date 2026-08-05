import * as assert from 'assert';
import {
  isKnownSimpleKeyword,
  ALL_SIMPLE_KEYWORDS,
  RUNTYPE_KEYWORDS,
  DFT_FUNCTIONAL_KEYWORDS,
  BASIS_KEYWORDS
} from '../src/keywords';

describe('keywords: ALL_SIMPLE_KEYWORDS aggregation', () => {
  it('includes every category list', () => {
    for (const k of RUNTYPE_KEYWORDS) {
      assert.ok(ALL_SIMPLE_KEYWORDS.includes(k), `expected ${k} in ALL_SIMPLE_KEYWORDS`);
    }
    for (const k of DFT_FUNCTIONAL_KEYWORDS) {
      assert.ok(ALL_SIMPLE_KEYWORDS.includes(k), `expected ${k} in ALL_SIMPLE_KEYWORDS`);
    }
  });
});

describe('isKnownSimpleKeyword: literal matches', () => {
  it('recognizes exact-case literal keywords', () => {
    assert.strictEqual(isKnownSimpleKeyword('HF'), true);
    assert.strictEqual(isKnownSimpleKeyword('B3LYP'), true);
    assert.strictEqual(isKnownSimpleKeyword('def2-SVP'), true);
    assert.strictEqual(isKnownSimpleKeyword('OPT'), true);
  });

  it('is case-insensitive', () => {
    assert.strictEqual(isKnownSimpleKeyword('hf'), true);
    assert.strictEqual(isKnownSimpleKeyword('b3lyp'), true);
    assert.strictEqual(isKnownSimpleKeyword('Def2-Svp'), true);
  });

  it('rejects tokens that are not keywords at all', () => {
    assert.strictEqual(isKnownSimpleKeyword('NOTAREALKEYWORD'), false);
    assert.strictEqual(isKnownSimpleKeyword('FOOBAR123'), false);
  });
});

describe('isKnownSimpleKeyword: pattern-family matches (KNOWN_PATTERN_REGEXES)', () => {
  it('accepts CPCM(<solvent>) and SMD(<solvent>) with any solvent name', () => {
    assert.strictEqual(isKnownSimpleKeyword('CPCM(water)'), true);
    assert.strictEqual(isKnownSimpleKeyword('CPCM(toluene)'), true);
    assert.strictEqual(isKnownSimpleKeyword('SMD(acetonitrile)'), true);
  });

  it('rejects CPCM with no parenthesized solvent', () => {
    assert.strictEqual(isKnownSimpleKeyword('CPCM'), false);
    assert.strictEqual(isKnownSimpleKeyword('CPCM()'), false);
  });

  it('accepts PAL<n> for any n but not PAL alone', () => {
    assert.strictEqual(isKnownSimpleKeyword('PAL4'), true);
    assert.strictEqual(isKnownSimpleKeyword('PAL16'), true);
    assert.strictEqual(isKnownSimpleKeyword('PAL'), false);
  });

  it('accepts SCFCONV<n>', () => {
    assert.strictEqual(isKnownSimpleKeyword('SCFCONV8'), true);
    assert.strictEqual(isKnownSimpleKeyword('SCFCONV'), false);
  });

  it('accepts DKH-/ZORA- recontracted basis sets not spelled out literally', () => {
    assert.strictEqual(isKnownSimpleKeyword('DKH-def2-TZVP'), true);
    assert.strictEqual(isKnownSimpleKeyword('ZORA-def2-QZVPP'), true);
    assert.strictEqual(isKnownSimpleKeyword('ma-DKH-TZVP'), true);
  });

  it('accepts the cc-pVnZ family with recognized suffixes', () => {
    assert.strictEqual(isKnownSimpleKeyword('cc-pVTZ-DK'), true);
    assert.strictEqual(isKnownSimpleKeyword('aug-cc-pV5Z-PP'), true);
    assert.strictEqual(isKnownSimpleKeyword('cc-pVQZ-F12-CABS'), true);
  });

  it('accepts NEB job variants not spelled out literally', () => {
    assert.strictEqual(isKnownSimpleKeyword('TIGHT-NEB'), true);
    assert.strictEqual(isKnownSimpleKeyword('NEB-IDPP'), true); // also literal
  });

  it('accepts DLPNO-<method> and AUTOCI-<method> generically', () => {
    assert.strictEqual(isKnownSimpleKeyword('DLPNO-CCSD(T1)-F12/D'), true); // also literal
    assert.strictEqual(isKnownSimpleKeyword('DLPNO-MADEUP'), true); // pattern-only
    assert.strictEqual(isKnownSimpleKeyword('AUTOCI-MADEUP'), true); // pattern-only
  });

  it('does not let unrelated tokens slip through a similarly-prefixed pattern', () => {
    assert.strictEqual(isKnownSimpleKeyword('DKHTZVP'), false); // missing required '-'
    assert.strictEqual(isKnownSimpleKeyword('NEBFOO'), false); // no separator before suffix
  });
});

describe('BASIS_KEYWORDS sanity', () => {
  it('contains the commonly used def2-SVP/TZVP family literally', () => {
    assert.ok(BASIS_KEYWORDS.includes('def2-SVP'));
    assert.ok(BASIS_KEYWORDS.includes('def2-TZVP'));
  });
});
