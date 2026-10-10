// Commands for the working directories of the uv-vis NEA scripts
// (https://github.com/alestoman5/uv-vis, scripts/): quick access to the
// outputs and a command-line builder for the three entry scripts. The
// progress overview lives in the Orbital Studio Calculations tab.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findGeomSets } from '../chem/neaRun';
import { openFile, targetPath } from './io';
import { NeaScript, buildNeaCommand } from '../inputs/nea';

function runFolder(uri?: vscode.Uri): string | undefined {
  const p = targetPath(uri);
  if (!p) {
    return undefined;
  }
  return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
}

const OUTPUTS = [
  'spectrum/spectrum.png', 'spectrum/summary.txt', 'comparison.png', 'comparison.txt',
  'pipeline.log', 'run.log', 'run_config.json'
];

export async function neaOpenOutputs(uri?: vscode.Uri): Promise<void> {
  const folder = runFolder(uri);
  if (!folder) {
    return;
  }
  const found: string[] = [];
  for (const base of [folder, ...findGeomSets(folder).map(d => path.dirname(d)).filter(d => d !== folder)]) {
    found.push(...OUTPUTS.map(f => path.join(base, f)).filter(f => fs.existsSync(f)));
  }
  if (found.length === 0) {
    vscode.window.showInformationMessage(`No NEA outputs (spectrum/, comparison.*, pipeline.log) in ${folder}.`);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    found.map(f => ({ label: path.relative(folder, f), file: f })),
    { title: `Outputs of ${path.basename(folder)}` }
  );
  if (!pick) {
    return;
  }
  if (/\.png$/i.test(pick.file)) {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pick.file));
  } else {
    await openFile(pick.file);
  }
}

async function findScriptsDir(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('orcaInp').get<string>('nea.scriptsDir', '');
  if (configured) {
    return configured;
  }
  const hits = await vscode.workspace.findFiles('**/scripts/from_geometry.py', '**/{node_modules,.git}/**', 1);
  return hits.length > 0 ? path.dirname(hits[0].fsPath) : undefined;
}

/** Builds a from_geometry / from_ensemble / compare_ensembles command and types it into a terminal (not run). */
export async function neaCommand(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const scripts = await findScriptsDir();
  if (!scripts) {
    vscode.window.showErrorMessage('scripts/from_geometry.py not found in the workspace — set orcaInp.nea.scriptsDir.');
    return;
  }
  const root = path.dirname(scripts);
  const script = await vscode.window.showQuickPick([
    { label: 'from_geometry.py', description: 'one geometry / molden / MD trajectory + sampling' },
    { label: 'from_ensemble.py', description: 'multi-XYZ file of geometries' },
    { label: 'compare_ensembles.py', description: 'several geometry sets, one comparison plot' }
  ], { title: 'NEA script' });
  if (!script) {
    return;
  }
  const compare = script.label === 'compare_ensembles.py';
  let inputs = (uris && uris.length > 0 ? uris : uri instanceof vscode.Uri ? [uri] : []).map(u => u.fsPath);
  if (inputs.length === 0) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: compare, canSelectFolders: compare, canSelectFiles: true,
      title: compare ? 'Geometry sets (.xyz or finished working directories)' : 'Input file',
      defaultUri: vscode.Uri.file(root)
    });
    if (!picked) {
      return;
    }
    inputs = picked.map(u => u.fsPath);
  }
  let sampling: 'wigner' | 'md' | undefined;
  if (script.label === 'from_geometry.py') {
    const picked = await vscode.window.showQuickPick(['wigner', 'md'], { title: 'Sampling' });
    if (!picked) {
      return;
    }
    sampling = picked as 'wigner' | 'md';
  }
  const command = buildNeaCommand({ script: script.label as NeaScript, root, inputs, sampling });
  const cmd = await vscode.window.showInputBox({
    title: `Edit, then Enter to type it into a terminal in ${root} (it is not run)`,
    value: command,
    ignoreFocusOut: true
  });
  if (!cmd) {
    return;
  }
  const term = vscode.window.createTerminal({ name: 'NEA', cwd: root });
  term.show();
  term.sendText(cmd, false);
}
