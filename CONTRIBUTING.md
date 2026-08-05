# Contributing

Thanks for considering a contribution to the ORCA Input (.inp) extension.
This covers local setup, running the tests, and packaging a `.vsix` — for a
user-facing overview of the extension itself, see [README.md](./README.md).

## Project layout

```
package.json                 extension manifest (contributes, activation)
language-configuration.json  comments, brackets, word pattern
syntaxes/orca.tmLanguage.json TextMate grammar (highlighting)
snippets/orca.json           job-type snippets
src/keywords.ts              reference lists: methods, basis sets, blocks
src/diagnostics.ts           structural linting logic
src/completion.ts            context-aware autocomplete
src/hover.ts                 hover documentation
src/extension.ts             activation / wiring
test/                        unit tests (mocha + ts-node)
```

## Running it locally

```bash
npm install
npm run compile
```

Then in VS Code: **Run and Debug → "Launch Extension"** (or press `F5`).
This opens a new VS Code window with the extension loaded — open any `.inp`
file there to try your changes.

If you don't have a launch config yet, create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Launch Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"],
      "preLaunchTask": "npm: compile"
    }
  ]
}
```

## Running the tests

```bash
npm install
npm test
```

Tests run under plain Node + `ts-node`/`mocha`, not `@vscode/test-electron` —
`src/diagnostics.ts`, `src/completion.ts` and `src/hover.ts` take
`vscode.TextDocument`/etc. as plain parameters, so `test/mocks/vscode.ts`
stands in for the real `vscode` module (only implementing the surface those
files touch) via a `require('vscode')` patch in
`test/register-vscode-mock.js`. `src/keywords.ts` has no `vscode` dependency
and is tested directly.

Requires Node 22.6+ (the test setup disables Node's native TypeScript
stripping via `--no-experimental-strip-types` so `ts-node`'s CommonJS
require hook handles `.ts` files instead — that flag doesn't exist on older
Node versions).

## Extending the keyword lists

`src/keywords.ts` is intentionally not exhaustive — ORCA has hundreds of
keywords across versions. The lists there cover common DFT/HF/MP2/CC
workflows. If diagnostics flag a keyword you use often as "unrecognized",
add it to the relevant array (`RUNTYPE_KEYWORDS`, `WAVEFUNCTION_METHOD_KEYWORDS`,
`DFT_FUNCTIONAL_KEYWORDS`, `BASIS_KEYWORDS`, `BLOCK_NAMES`, `BLOCK_OPTIONS`,
etc.) and open a PR — add or update the matching test in `test/keywords.test.ts`
alongside it.

## Packaging a `.vsix`

```bash
npm install -g @vscode/vsce
npm run compile
vsce package
```

This produces `orca-inp-<version>.vsix`. Install it locally with:

```bash
code --install-extension orca-inp-<version>.vsix
```

or via the Extensions view → "..." menu → **Install from VSIX**.

## Roadmap ideas

- Fix nested `%block` syntax highlighting to match the diagnostics linter's
  stack-based matching (see README's Known Limitations).
- Parsing of `.out` files — could be a companion feature/extension (progress
  indicator on convergence, imaginary-frequency count, etc.).
- Keyword lists could be auto-generated from the ORCA manual PDF.
- Unit tests for `src/extension.ts`'s activation/wiring (would need
  `@vscode/test-electron` rather than the lightweight `vscode` mock the rest
  of the suite uses).
