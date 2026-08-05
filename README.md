# ORCA Input (.inp) — VS Code extension

Syntax highlighting, structural diagnostics, and autocompletion for
[ORCA](https://orcaforum.kofo.mpg.de/) quantum-chemistry `.inp` input files.

## Features

- **Syntax highlighting** for simple-input lines (`! B3LYP def2-TZVP D4`),
  `%block ... end` regions, coordinate blocks (`* xyz 0 1 ... *`), comments,
  numbers and strings.
- **Diagnostics** (update live as you type):
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
- **Hover**: hovering a recognized simple-input keyword or a `%block` name
  shows a short description.
- **Snippets**: type one of these prefixes in a `.inp` file and hit
  Tab/Enter to expand it:
  - `orca-sp` — single-point energy
  - `orca-optfreq` — geometry optimization + frequencies
  - `orca-tddft` — TD-DFT excited states
  - `orca-optts` — transition-state optimization
  - `orca-pal` — `%pal` parallelization block
  - `orca-constraints` — `%geom Constraints ... end` block
  - `orca-cpcm` — implicit solvation with CPCM

## Installing

This extension isn't on the VS Code Marketplace yet, so for now it's
installed from a `.vsix` package built from this repo (see
[CONTRIBUTING.md](./CONTRIBUTING.md#packaging-a-vsix) for the build steps):

1. In VS Code, open the Extensions view, click the **"..."** menu at the
   top, and choose **Install from VSIX...** — or from a terminal:
   ```bash
   code --install-extension orca-inp-0.1.0.vsix
   ```
2. Open a `.inp` file — the extension activates automatically for that
   file type.

It also works in VSCodium and other VS Code-compatible editors that support
installing from a `.vsix`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `orcaInp.diagnostics.enable` | `true` | Turn live diagnostics on/off entirely. |
| `orcaInp.diagnostics.unknownKeywordSeverity` | `warning` | How to flag a simple-input (`!`) keyword the extension doesn't recognize. One of `error`, `warning`, `information`, or `off`. |

If a keyword you know is valid ORCA syntax keeps getting flagged as
"unrecognized" (the built-in keyword list isn't exhaustive — see below), set:

```json
"orcaInp.diagnostics.unknownKeywordSeverity": "off"
```

or open an issue / PR so it can be added to the extension's keyword list for
everyone.

## Keyword coverage

The extension recognizes **~610 literal simple-input keywords** — runtypes,
HF/MP2/CC/CASSCF/MRCI/DLPNO/AUTOCI/semiempirical methods, the DFT functional
zoo, basis sets, auxiliary basis sets, ECPs, relativistic/SOC options, and
SCF/convergence/output switches — plus **~20 patterns** for parametrized
families the ORCA manual documents via placeholders (the `cc-pV{D,T,Q,5,6}Z`
family with its `-DK`/`-PP`/`-F12` suffixes, `DKH-`/`ZORA-`/`ma-` prefixed
basis sets, `PAL<n>`, `CPCM(solvent)`, `Extrapolate(...)`, etc.), and the
complete list of 35 `%block` names, compiled from the official ORCA manual's
["General Structure of the Input File"](https://www.faccts.de/docs/orca/6.1/manual/contents/essentialelements/input.html)
chapter.

This is *not* literally every keyword ORCA has — the full manual runs past a
thousand pages and documents thousands of block-internal variables (inside
`%scf`, `%tddft`, `%mdci`, `%casscf`, ...) that aren't practical to enumerate.
What's covered comprehensively is the "simple input" line (everything after
`!`), since that's a closed, well-documented list and the part people type —
and mistype — the most. Block *contents* only get light-touch coverage and
aren't flagged as unknown when unrecognized, to avoid false positives.

## Known limitations

- Nested `%block` highlighting (e.g. `%geom ... Constraints ... end ... end`)
  is v0.1-quality: the *diagnostics* correctly track nested blocks, but the
  syntax *highlighting* treats the first `end` it meets as the block close.
- No parsing of `.out` files — the extension only understands `.inp` input,
  not ORCA's output.

## Contributing

Bug reports, keyword-list additions, and PRs are welcome — see
[CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, running the tests, and
packaging/publishing instructions.

## License

MIT — see [LICENSE](./LICENSE).
