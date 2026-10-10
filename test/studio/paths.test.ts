import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HostContext } from '../../src/studio/context';
import { allowUserPaths, clearUserPaths, isAllowedPath, isInside, isReallyInside, isUserChosen, pathsInArgs } from '../../src/studio/paths';

describe('studio paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbital-paths-'));
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.png'), 'x');
  const ctx = { workspaceFolders: () => [ws] } as unknown as HostContext;

  after(() => {
    clearUserPaths();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('isInside handles .., sibling prefixes and names starting with two dots', () => {
    assert.ok(isInside(path.join(ws, 'a', 'b'), ws));
    assert.ok(isInside(ws, ws));
    assert.ok(isInside(path.join(ws, '..data'), ws));
    assert.ok(!isInside(path.join(ws, '..', 'outside'), ws));
    assert.ok(!isInside(ws + '-other', ws));
  });

  it('a symlink or junction inside the workspace pointing outside is not inside', function () {
    const link = path.join(ws, 'link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      this.skip();
    }
    assert.ok(isInside(path.join(link, 'secret.png'), ws), 'lexically inside');
    assert.ok(!isReallyInside(path.join(link, 'secret.png'), ws), 'really outside');
    assert.ok(!isAllowedPath(ctx, path.join(link, 'secret.png')));
    assert.ok(isAllowedPath(ctx, path.join(ws, 'not-yet-created', 'f.txt')));
  });

  it('user-chosen paths (dialogs, command arguments) are allowed, including files below a chosen folder', () => {
    clearUserPaths();
    assert.ok(!isAllowedPath(ctx, path.join(outside, 'secret.png')));
    allowUserPaths(pathsInArgs({ folder: outside, files: ['relative.txt'], n: 3 }));
    assert.ok(isUserChosen(path.join(outside, 'secret.png')));
    assert.ok(isAllowedPath(ctx, path.join(outside, 'secret.png')));
    assert.ok(!isUserChosen(path.join(root, 'relative.txt')));
  });
});
