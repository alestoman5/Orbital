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

## Installation

This extension isn't on the VS Code Marketplace yet, so install it from a
`.vsix` package:

1. Download the `.vsix` file (or build one — see below).
2. In VS Code, open the Extensions view → "..." menu → **Install from VSIX**,
   and pick the file. Or from a terminal:
   ```bash
   code --install-extension orca-inp-0.1.0.vsix
   ```

Once installed, opening any `.inp` file automatically enables syntax
highlighting, diagnostics, autocompletion, snippets, and hover info — no
extra setup needed.

### Building the `.vsix` yourself

```bash
npm install
npm install -g @vscode/vsce
vsce package
```

This produces `orca-inp-0.1.0.vsix` in the project folder, ready to install
as described above.

## Settings

To turn off the "unrecognized keyword" diagnostic, add this to your VS Code
settings:

```json
"orcaInp.diagnostics.unknownKeywordSeverity": "off"
```

## Known limitations

- Nested `%block` regions (e.g. `%geom ... Constraints ... end ... end`) are
  handled correctly by the diagnostics (unclosed/stray `end` checks), but
  syntax *highlighting* treats the first `end` it meets as the block close,
  so nested blocks can highlight a little oddly.
- No parsing of `.out` result files yet (e.g. convergence progress,
  imaginary-frequency counts) — `.inp` input files only, for now.

## License

MIT — see [LICENSE](./LICENSE).
