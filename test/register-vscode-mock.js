'use strict';
// Mocha --require hook (see .mocharc.json). Patches Node's module loader so
// `import * as vscode from 'vscode'` inside src/*.ts resolves to our
// lightweight test/mocks/vscode.ts stand-in instead of failing, since the
// real 'vscode' module only exists inside a running extension host.
//
// Must be required *after* ts-node/register (see .mocharc.json ordering) so
// the lazily-required mock file below can itself be compiled on the fly.

const Module = require('module');
const path = require('path');

const mockPath = path.join(__dirname, 'mocks', 'vscode.ts');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return originalLoad.call(this, mockPath, parent, isMain);
  }
  return originalLoad.apply(this, arguments);
};
