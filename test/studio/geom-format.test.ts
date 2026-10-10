import * as assert from 'assert';
import { legendLabels } from '../../webview/src/tabs/geom/format';

describe('geom: legend labels', () => {
  it('drops the shared file name and leading folders', () => {
    assert.deepStrictEqual(legendLabels(['MD/CMD_PBEPBE/geoms.xyz', 'MD/GLE_PBEPBE/geoms.xyz']), ['CMD_PBEPBE', 'GLE_PBEPBE']);
  });
  it('keeps distinct file names', () => {
    assert.deepStrictEqual(legendLabels(['a/x.xyz', 'a/y.xyz']), ['x.xyz', 'y.xyz']);
  });
  it('keeps the labels when shortening would merge them', () => {
    assert.deepStrictEqual(legendLabels(['geoms.xyz', 'geoms.xyz']), ['geoms.xyz', 'geoms.xyz']);
  });
  it('leaves a single label alone', () => {
    assert.deepStrictEqual(legendLabels(['MD/CMD/geoms.xyz']), ['MD/CMD/geoms.xyz']);
  });
});
