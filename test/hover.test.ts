import * as assert from 'assert';
import { OrcaHoverProvider } from '../src/hover';
import { Position } from './mocks/vscode';
import { makeDoc } from './helpers/fakeDocument';
import { BLOCK_DOCS, KEYWORD_DOCS } from '../src/keywords';

const provider = new OrcaHoverProvider();

function hoverAt(lines: string[], line: number, character: number): any {
  const doc = makeDoc(lines);
  return provider.provideHover(doc as any, new Position(line, character) as any);
}

describe('OrcaHoverProvider: block names', () => {
  it('shows the curated block doc when one exists', () => {
    const hover = hoverAt(['%pal nprocs 4'], 0, 2); // inside "pal"
    assert.ok(hover);
    assert.strictEqual(hover.contents.value, `**%pal** — ${BLOCK_DOCS['pal']}`);
  });

  it('falls back to a generic block description when no curated doc exists', () => {
    // 'cipsi' is a valid block name (BLOCK_NAMES) with no BLOCK_DOCS entry.
    const hover = hoverAt(['%cipsi'], 0, 3);
    assert.ok(hover);
    assert.strictEqual(hover.contents.value, '**%cipsi** — ORCA input block.');
  });
});

describe('OrcaHoverProvider: simple-input keywords ("!" lines)', () => {
  it('shows the curated keyword doc when one exists', () => {
    const hover = hoverAt(['! SP def2-SVP'], 0, 3); // inside "SP"
    assert.ok(hover);
    assert.strictEqual(hover.contents.value, `**SP** — ${KEYWORD_DOCS['SP']}`);
  });

  it('falls back to a category description when the keyword is known but undocumented', () => {
    // 'HF' is a recognized WAVEFUNCTION_METHOD_KEYWORDS entry with no KEYWORD_DOCS entry.
    const hover = hoverAt(['! HF def2-SVP'], 0, 3);
    assert.ok(hover);
    assert.strictEqual(
      hover.contents.value,
      '**HF** — Wavefunction-based electronic structure method.'
    );
  });

  it('returns undefined for an unrecognized keyword', () => {
    const hover = hoverAt(['! NOTAREALKEYWORD'], 0, 5);
    assert.strictEqual(hover, undefined);
  });
});

describe('OrcaHoverProvider: outside any hoverable context', () => {
  it('returns undefined on a coordinate/atom line', () => {
    const hover = hoverAt(['C 0 0 0'], 0, 0);
    assert.strictEqual(hover, undefined);
  });

  it('returns undefined when the position is not on any word', () => {
    const hover = hoverAt(['!    HF'], 0, 2); // deep in the gap between "!" and "HF"
    assert.strictEqual(hover, undefined);
  });
});
