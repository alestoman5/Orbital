# ORCA Input (.inp) — VS Code extension

Syntax highlighting, structural diagnostics, and autocompletion for
[ORCA](https://orcaforum.kofo.mpg.de/) quantum-chemistry `.inp` input files.

## Features

- **Syntax highlighting** for simple-input lines (`! B3LYP def2-TZVP D4`),
  `%block ... end` regions, coordinate blocks (`* xyz 0 1 ... *`), comments,
  numbers and strings.
- **Diagnostics** (updates live as you type):
  - unclosed `%block` (missing `end`)
  - stray `end` with no matching `%block`
  - unclosed coordinate block (`*` opened but never closed)
  - malformed coordinate block header (missing charge/multiplicity)
  - unrecognized simple-input keywords (configurable severity)
  - missing simple-input line / missing coordinate block (info hints)
- **Autocompletion**:
  - method/functional and basis-set names after `!`
  - block names after `%`
  - common block options while inside a `%block ... end` region
  - coordinate block types (`xyz`, `xyzfile`, `int`, `gzmt`) after `*`
- **Snippets**: `orca-sp`, `orca-optfreq`, `orca-tddft`, `orca-optts`,
  `orca-pal`, `orca-constraints`, `orca-cpcm` (type the prefix in a `.inp`
  file and hit Tab/Enter).
- **Hover**: hovering a recognized simple-input keyword or a `%block`
  name shows a short description.

## Keyword coverage

`src/keywords.ts` is compiled from the official ORCA manual's
["General Structure of the Input File"](https://www.faccts.de/docs/orca/6.1/manual/contents/essentialelements/input.html)
chapter and currently recognizes **~610 literal simple-input keywords**
(runtypes, HF/MP2/CC/CASSCF/MRCI/DLPNO/AUTOCI/semiempirical methods, the
full DFT functional zoo, basis sets, auxiliary basis sets, ECPs,
relativistic/SOC options, SCF/convergence/output switches) plus **~20
regex patterns** for the parametrized families the manual documents via
placeholders (`cc-pV{D,T,Q,5,6}Z[-DK|-PP|-F12...]`, `DKH-`/`ZORA-`/`ma-`
prefixed basis sets, `PAL<n>`, `CPCM(solvent)`, `Extrapolate(...)`, etc.),
and the **complete list of 35 `%block` names**.

This is *not* literally every keyword ORCA has — the full manual runs
past a thousand pages and documents thousands of block-internal
variables (inside `%scf`, `%tddft`, `%mdci`, `%casscf`, ...) that aren't
practical to enumerate or keep in sync by hand. What's covered
comprehensively is the "simple input" line (everything after `!`),
since that's a closed, well-documented list and the part people type —
and mistype — the most. Block *contents* only get light-touch coverage
(`BLOCK_OPTIONS` in `keywords.ts`) and aren't flagged as unknown if
unrecognized, to avoid false positives.

## Try it locally (no publishing needed)

```bash
npm install
npm run compile
```

Then in VS Code: **Run and Debug → "Launch Extension"** (or press `F5`).
This opens a new VS Code window with the extension loaded — open any
`.inp` file there to try it.

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

## Packaging a `.vsix` (install without publishing)

```bash
npm install -g @vscode/vsce
vsce package
```

This produces `orca-inp-0.1.0.vsix`. Install it with:

```bash
code --install-extension orca-inp-0.1.0.vsix
```

or via the Extensions view → "..." menu → **Install from VSIX**.

## Publishing to the VS Code Marketplace

1. Create a [publisher](https://marketplace.visualstudio.com/manage) and
   an Azure DevOps Personal Access Token.
2. Update `publisher` in `package.json` to your publisher id.
3. `vsce login <publisher>` then `vsce publish`.

You can also list it on [Open VSX](https://open-vsx.org/) (`ovsx publish`)
so it's available to VSCodium / non-Microsoft-marketplace editors.

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

## Running the tests

```
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
just add it to the relevant array (`JOB_KEYWORDS`, `METHOD_KEYWORDS`,
`BASIS_KEYWORDS`, `BLOCK_NAMES`, or `BLOCK_OPTIONS`).

To disable the unknown-keyword warning entirely, set in VS Code settings:

```json
"orcaInp.diagnostics.unknownKeywordSeverity": "off"
```

## Known limitations / roadmap ideas

- The `%geom ... Constraints ... end ... end` nested-block case is handled
  correctly by the diagnostics linter (proper stack-based matching), but
  the *grammar* (highlighting) treats the first `end` it meets as the
  block close — nested `%block` highlighting is v0.1-quality, contributions
  welcome.
- No hover-provider yet (e.g. showing a short description of a keyword on
  hover) — would be a natural next feature using the same keyword data.
- No parsing of `.out` files yet — could be a companion feature/extension
  (progress indicator on convergence, imaginary-frequency count, etc.).
- Keyword lists could be auto-generated from the ORCA manual PDF.

Contributions and PRs welcome — this is meant to be a community tool for
people running ORCA day to day.

## License

MIT — see [LICENSE](./LICENSE).
