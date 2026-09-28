import * as assert from 'assert';
import * as path from 'path';
import { getOutPathForBasename, getXyzPathForBasename, sameBasename } from '../../src/outparser/paths';

describe('outparser/paths', () => {
  it('getOutPathForBasename swaps the extension to .out', () => {
    assert.strictEqual(getOutPathForBasename('/a/b/water.inp'), path.join('/a/b', 'water.out'));
  });

  it('getXyzPathForBasename swaps the extension to .xyz', () => {
    assert.strictEqual(getXyzPathForBasename('/a/b/water.out'), path.join('/a/b', 'water.xyz'));
  });

  it('sameBasename is true for matching dir+basename regardless of extension', () => {
    assert.strictEqual(sameBasename('/a/b/water.inp', '/a/b/water.out'), true);
  });

  it('sameBasename is false for a different directory or basename', () => {
    assert.strictEqual(sameBasename('/a/b/water.inp', '/a/c/water.out'), false);
    assert.strictEqual(sameBasename('/a/b/water.inp', '/a/b/methane.out'), false);
  });
});
