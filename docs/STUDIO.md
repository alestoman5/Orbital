# Orbital Studio: architecture and conventions

Orbital Studio is one webview panel (`Orbital: Open Orbital Studio`) with tabs for spectra, calculations, runs, geometries, the input builder, machine learning and the report editor. It generalizes the uv-vis web app (github.com/alestoman5/uv-vis, `webapp/`) and runs entirely inside the extension. Python is only needed for ML (and optionally to run PySCF jobs).

## Layout

```
src/studio/
  protocol.ts        message types shared by host and webview (no vscode/Node/DOM imports)
  context.ts         HostContext: everything a tab host may use instead of `vscode`
  registry.ts        TAB_HOSTS + request dispatchers (shared by panel and dev harness)
  panel.ts           the VS Code WebviewPanel, CSP, command orcaInp.openStudio
  vscodeContext.ts   HostContext implemented with the VS Code API
  tabs/<tab>/host.ts   host side of a tab: { id, methods, activate? }
  tabs/<tab>/types.ts  request/response/event types of that tab (types only)
webview/
  src/main.ts        shell: rail, header, lazy tab mount, theme, navigate events
  src/rpc.ts         request/response + events over postMessage
  src/view.ts        TabView / ViewContext contract
  src/registry.ts    tab list (titles, icons)
  src/ui/            DOM builder (dom.ts), components (components.ts), icons (icons.ts)
  src/charts/        SVG chart engine: api.ts is the frozen public interface
  src/styles/        tokens.css (design tokens), shell.css, components.css
  src/tabs/<tab>/    webview side of a tab: export const view: TabView
  dev/               browser dev harness (server.mjs, nodeContext.ts, screenshot.sh)
contrib/<area>.json  settings/commands a tab needs (merged into package.json by the orchestrator)
python/              helper scripts shipped with the extension (ml_worker.py)
esbuild.mjs          webview bundle -> out/webview/studio.{js,css}
```

Data flow: the webview calls `ctx.rpc('method', params)`, which reaches `TAB_HOSTS[tab].methods.method(params, hostContext)` in the extension host and resolves with its return value. The host pushes events with `hostContext.post(name, payload)`, and the webview receives them with `ctx.on(name, cb)`. Commands open a tab with arguments through `openStudio(extensionUri, tab, args)`, which calls `TabInstance.onNavigate(args)`.

## Commands

| | |
|---|---|
| `npm run compile` | tsc (extension) + webview typecheck + esbuild bundle |
| `npm test` | mocha, all `test/**/*.test.ts` |
| `npm run typecheck:webview` | webview type check only |
| `npm run dev:webview -- --workspace ../uv-vis --port 5173` | dev harness: browser UI + real tab hosts in Node against a folder |
| `webview/dev/screenshot.sh out.png "tab=spectra&theme=dark" 1400 900 5173` | headless Edge/Chrome screenshot (themes: dark, light, hc) |

Dev harness URLs: `http://localhost:5173/?tab=geom&theme=light&args=<url-encoded JSON>`. `args` reaches the tab as `onNavigate(args)`, `fresh=1` ignores saved state, and `shot=1` hides the dev bar and disables the event stream (needed for headless screenshots). Files a tab saves land in `<workspace>/.orbital/dev-exports/`. Workspace files can be fetched by the page as `/fs/<absolute path>` (in VS Code: ask the host for a webview URI).

## Rules for tab code

**Ownership.** A tab owns `src/studio/tabs/<tab>/**`, `webview/src/tabs/<tab>/**`, `test/studio/<tab>*.test.ts` and `contrib/<tab>.json`. Only the orchestrator edits these shared files: `package.json`, `package-lock.json`, `src/extension.ts`, `src/studio/{protocol,context,registry,panel,vscodeContext}.ts`, `webview/src/{main,rpc,view,registry}.ts`, `webview/src/ui/**`, `webview/src/styles/**`, `webview/src/charts/api.ts`, `esbuild.mjs`, `webview/dev/{server.mjs,nodeContext.ts,hostEntry.ts,dev-client.js,index.html}`, `.vscodeignore` and `README.md`. If you need a change there (a new UI component, a protocol field, a dependency), stop and describe it in your report. Do not work around it.

**Host side.**
- Never import `vscode` from `src/studio/tabs/**` or from modules they import (that includes `src/features/*.ts`, which do). Use the `HostContext`. Pure modules in `src/chem`, `src/outparser`, `src/inputs` etc. are fine.
- Validate params. They come from the webview. Paths must resolve inside a workspace folder (or be a file the user picked).
- Return plain JSON (numbers, strings, arrays, objects). Send large numeric arrays as `number[]` and downsample to what a plot needs: a 1000–4000 point grid is plenty.
- Cache parsed files by `(path, mtimeMs)`. Ensembles have 10⁵ geometries, so stream or read once.
- Settings are `ctx.config('studio.<name>', default)`. Declare each one in `contrib/<tab>.json` with the same default.

**Webview side.**
- Build the UI from `webview/src/ui/components.ts` (`split`, `card`, `kpi`, `dataTable`, `field`, `select`, `toggle`, `segmented`, `subTabs`, `section`, `emptyState`, `skeleton`, `callout`, `button`, `badge`, `stackedBar`, `toast`, `busy`) and `h()` from `ui/dom.ts`.
- Colors come only from CSS variables in `styles/tokens.css`. Write no raw hex in tab CSS. Chart colors come from the chart engine (Okabe-Ito).
- Tab CSS goes in `webview/src/tabs/<tab>/<tab>.css`, imported from the tab's `index.ts`, with every selector prefixed by `[data-tab="<tab>"]`.
- Every plot goes through `webview/src/charts` (`render`, `figureToolbar`, `toSvg/toPdf/toPng/toCsv`). Do not draw charts by hand.
- Use the empty, loading and error states: `emptyState(...)` when there is no data, `skeleton()` while loading, `toast(..., 'error')` or `callout('bad', ...)` on failure. Never leave a blank area.
- Persist small UI state (selections, form values) with `ctx.state` / `ctx.setState`.
- Must work in dark, light and high-contrast themes, and down to 760 px panel width.

**Publication-quality figures.** Axis labels use the "quantity / unit" form (`λ / nm`, `E / eV`, `σ / cm^{2} molecule^{−1}`). The default export preset is 'publication', and journal sizes come from `JOURNAL_SIZES`. CI bands are drawn under their curves and share a `group` with them. Experiment is drawn dashed in `EXP_COLOR` and a reference curve in `REF_COLOR`.

**contrib/<tab>.json** format, merged into `package.json` `contributes` by the orchestrator:
```json
{
  "configuration": {
    "orcaInp.studio.spectraGlobs": { "type": "array", "items": { "type": "string" }, "default": ["**/*.cross.dat"], "description": "..." }
  },
  "commands": [ { "command": "orcaInp.newInput", "title": "New ORCA/PySCF Input", "category": "Orbital" } ],
  "menus": { "explorer/context": [ { "command": "orcaInp.newInput", "when": "resourceExtname == .xyz", "group": "7_orca" } ] },
  "notes": "free text for the orchestrator: commands to redirect, follow-ups"
}
```

**Tests.** Mocha + ts-node (transpile only), `test/**/*.test.ts`. Pure logic gets unit tests. Tab hosts are tested by calling `host.methods.x(params, fakeContext)` (see `test/studio/registry.test.ts` for a fake HostContext).

**Commits.** Use small commits with imperative subjects in the style of the existing history ("Add …", "Parse …"). End each message with the `Co-Authored-By` trailer you were given.
