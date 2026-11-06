import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { lintDocument } from './diagnostics';
import { OrcaCompletionProvider } from './completion';
import { OrcaHoverProvider } from './hover';
import { OutputStatusBar } from './outparser/statusBar';
import {
  createIrcInput,
  displaceAlongImaginaryMode,
  exportMolden,
  showWignerReport
} from './features/vibrationCommands';
import {
  boltzmannWeightsCommand,
  compareGeometries,
  createBasisVariants,
  exportPyneapples
} from './features/batchCommands';
import { RunsTreeProvider } from './features/runsTree';
import { neaCommand, neaOpenOutputs } from './features/neaRuns';
import { OutUnitHoverProvider } from './features/unitHover';
import { loadOutput, runFilesFor, targetPath } from './features/io';
import { summarizeRun } from './features/runSummary';
import { openStudio, registerStudio } from './studio/panel';

const LANGUAGE_ID = 'orca-inp';

export function activate(context: vscode.ExtensionContext): void {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('orca-inp');
  context.subscriptions.push(diagnosticCollection);

  function lintIfOrca(doc: vscode.TextDocument): void {
    if (doc.languageId === LANGUAGE_ID) {
      lintDocument(doc, diagnosticCollection);
    }
  }

  // Lint already-open documents on activation
  vscode.workspace.textDocuments.forEach(lintIfOrca);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(lintIfOrca),
    vscode.workspace.onDidChangeTextDocument(e => lintIfOrca(e.document)),
    vscode.workspace.onDidSaveTextDocument(lintIfOrca),
    vscode.workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('orcaInp')) {
        vscode.workspace.textDocuments.forEach(lintIfOrca);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      LANGUAGE_ID,
      new OrcaCompletionProvider(),
      '!', '%', '*', ' '
    )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(LANGUAGE_ID, new OrcaHoverProvider()),
    vscode.languages.registerHoverProvider({ scheme: 'file', pattern: '**/*.out' }, new OutUnitHoverProvider())
  );

  context.subscriptions.push(new OutputStatusBar());

  registerStudio(context);

  const runsTree = new RunsTreeProvider();
  context.subscriptions.push(
    runsTree,
    vscode.window.registerTreeDataProvider('orcaRuns', runsTree)
  );

  const commands: [string, (...args: any[]) => unknown][] = [
    ['orcaInp.displaceAlongImaginaryMode', (uri?: vscode.Uri, preset?: 'plus' | 'both') => displaceAlongImaginaryMode(uri, preset)],
    ['orcaInp.createIrcInput', (uri?: vscode.Uri) => createIrcInput(uri)],
    ['orcaInp.exportMolden', (uri?: vscode.Uri) => exportMolden(uri)],
    ['orcaInp.showWignerReport', (uri?: vscode.Uri) => showWignerReport(uri)],
    ['orcaInp.createBasisVariants', (uri?: vscode.Uri) => createBasisVariants(uri)],
    ['orcaInp.compareGeometries', (uri?: vscode.Uri) => compareGeometries(uri)],
    ['orcaInp.exportPyneapples', (uri?: vscode.Uri) => exportPyneapples(uri)],
    ['orcaInp.boltzmannWeights', (uri?: vscode.Uri, uris?: vscode.Uri[]) => boltzmannWeightsCommand(uri, uris)],
    ['orcaInp.previewSpectrum', (uri?: vscode.Uri) => {
      const p = targetPath(uri);
      openStudio(context.extensionUri, 'spectra', !p ? undefined : fs.existsSync(p) && fs.statSync(p).isDirectory() ? { folder: p } : { files: [p] });
    }],
    ['orcaInp.plotDat', (uri?: vscode.Uri) => {
      const p = targetPath(uri);
      if (p) {
        openStudio(context.extensionUri, 'geom', { dat: p });
      }
    }],
    ['orcaInp.neaOverview', (uri?: vscode.Uri) => {
      const p = targetPath(uri);
      openStudio(context.extensionUri, 'calcs', p ? { folder: fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p) } : undefined);
    }],
    ['orcaInp.editReport', (uri?: vscode.Uri) => {
      const p = targetPath(uri);
      openStudio(context.extensionUri, 'report', p && /\.tex$/i.test(p) ? { texFile: p } : undefined);
    }],
    ['orcaInp.newInput', (uri?: vscode.Uri) => {
      const p = targetPath(uri);
      openStudio(context.extensionUri, 'inputs', p && /\.(xyz|inp|out)$/i.test(p) ? { geometryFile: p } : undefined);
    }],
    ['orcaInp.openAccel', (uri?: vscode.Uri) => {
      const p = targetPath(uri);
      const isDir = p && fs.existsSync(p) && fs.statSync(p).isDirectory();
      const args = !p ? undefined
        : isDir ? { workdir: p }
          : path.basename(p) === 'accel.json' ? { workdir: path.dirname(p) }
            : /\.xyz$/i.test(p) ? { geometry: p } : undefined;
      openStudio(context.extensionUri, 'accel', args);
    }],
    ['orcaInp.openInViewer', (uri?: vscode.Uri, opts?: unknown) => {
      const p = targetPath(uri);
      const o = opts && typeof opts === 'object' ? (opts as { orbitals?: boolean; mode?: number }) : {};
      openStudio(context.extensionUri, 'viewer', p ? { file: p, orbitals: o.orbitals === true, mode: typeof o.mode === 'number' ? o.mode : undefined } : undefined);
    }],
    ['orcaInp.neaOpenOutputs', (uri?: vscode.Uri) => neaOpenOutputs(uri)],
    ['orcaInp.neaCommand', (uri?: vscode.Uri, uris?: vscode.Uri[]) => neaCommand(uri, uris)],
    ['orcaInp.runActions', (uri?: vscode.Uri) => runActions(uri)],
    ['orcaInp.runs.refresh', () => runsTree.refresh()],
    ['orcaInp.runs.toggleProblemsOnly', () => runsTree.toggleProblemsOnly()],
    ['orcaInp.runs.toggleProblemsOnlyOff', () => runsTree.toggleProblemsOnly()]
  ];
  for (const [id, handler] of commands) {
    // Tree-item context menus pass the RunItem; unwrap it to its .out URI.
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (arg?: unknown, ...rest: unknown[]) =>
        handler(arg && typeof arg === 'object' && 'outPath' in arg ? vscode.Uri.file((arg as { outPath: string }).outPath) : arg, ...rest)
      )
    );
  }
}

/** Status-bar click: the commands that make sense for the active run. */
async function runActions(uri?: vscode.Uri): Promise<void> {
  const p = targetPath(uri);
  if (!p) {
    return;
  }
  const files = runFilesFor(p);
  const parsed = loadOutput(files.out);
  const s = parsed ? summarizeRun(parsed) : undefined;
  const items: (vscode.QuickPickItem & { command: string; args?: unknown })[] = [];
  if (s?.verdict === 'saddle') {
    items.push({ label: '$(debug-step-over) Displace along imaginary mode', description: 'new input + xyz', command: 'orcaInp.displaceAlongImaginaryMode' });
  }
  if (s?.kind === 'optts') {
    items.push({ label: '$(git-compare) Create IRC input', command: 'orcaInp.createIrcInput' });
  }
  if (s?.hasFrequencies) {
    items.push(
      { label: '$(beaker) Wigner readiness report', command: 'orcaInp.showWignerReport' },
      { label: '$(export) Export Molden (normal modes)', description: 'for SHARC wigner.py', command: 'orcaInp.exportMolden' }
    );
  }
  if (parsed?.jobs.some(j => j.excitations && j.excitations.length > 0)) {
    items.push({ label: '$(graph-line) Preview spectrum', command: 'orcaInp.previewSpectrum' });
  }
  const steps = parsed?.jobs.reduce((n, j) => n + Math.max(j.optCycles.length, j.finalGeometry ? 1 : 0), 0) ?? 0;
  items.push({ label: '$(eye) Show in 3D viewer', description: steps > 1 ? `${steps} geometry steps` : undefined, command: 'orcaInp.openInViewer' });
  if (s?.hasFrequencies) {
    const imag = parsed?.jobs.flatMap(j => j.frequenciesCm1 ?? []).findIndex(f => f < -20) ?? -1;
    items.push({ label: '$(pulse) Animate normal modes', description: imag >= 0 ? 'starts with the imaginary mode' : undefined, command: 'orcaInp.openInViewer', args: { mode: imag >= 0 ? imag : undefined } });
  }
  if (files.out && /^\s*ORBITAL ENERGIES\s*$/m.test(safeRead(files.out))) {
    items.push({ label: '$(symbol-misc) Show orbitals', description: 'MO levels, composition, excited states, cube isosurfaces', command: 'orcaInp.openInViewer', args: { orbitals: true } });
  }
  items.push({ label: '$(go-to-file) Open output', command: 'vscode.open' });
  const pick = await vscode.window.showQuickPick(items, { title: `ORCA: ${files.base}` });
  if (pick) {
    await vscode.commands.executeCommand(pick.command, vscode.Uri.file(files.out), ...(pick.args ? [pick.args] : []));
  }
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function deactivate(): void {
  // nothing to clean up
}
