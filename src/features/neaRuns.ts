// Commands for the working directories of the uv-vis NEA scripts
// (https://github.com/alestoman5/uv-vis, scripts/): progress overview, quick
// access to the outputs, and a command-line builder for the three entry
// scripts. The spectrum preview of such a directory lives in spectrumPanel.ts.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GEOM_STATUSES, countXyzFrames, findGeomSets, readGeomSet } from '../chem/neaRun';
import { openFile, pickFolder, showMarkdown, targetPath } from './io';

function runFolder(uri?: vscode.Uri): string | undefined {
  const p = targetPath(uri);
  if (!p) {
    return undefined;
  }
  return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function neaOverview(uri?: vscode.Uri): Promise<void> {
  const folder = runFolder(uri) ?? (await pickFolder('NEA working directory'))?.fsPath;
  if (!folder) {
    return;
  }
  const sets = findGeomSets(folder);
  if (sets.length === 0) {
    vscode.window.showErrorMessage(`No geom_NNNN directories in ${folder} (or its geoms/, <label>/geoms/).`);
    return;
  }
  const md: string[] = [`# NEA run: ${path.basename(folder)}`, ''];
  const cfg = readJson(path.join(folder, 'run_config.json'));
  if (cfg) {
    const keys = ['method', 'basis', 'nstates', 'charge', 'mult', 'sampling', 'nsamples', 'reference', 'written'];
    md.push(...keys.filter(k => cfg[k] !== undefined && cfg[k] !== null).map(k => `- **${k}**: ${JSON.stringify(cfg[k])}`));
    if (typeof cfg.command === 'string') {
      md.push('', '```bash', cfg.command, '```');
    }
    md.push('');
  }
  for (const dir of sets) {
    const s = readGeomSet(dir);
    const label = path.relative(folder, dir).replace(/\/?geoms$/, '') || '.';
    const total = GEOM_STATUSES.reduce((n, k) => n + s.byStatus[k].length, 0);
    md.push(`## ${label}`, '');
    const ens = path.join(dir === folder ? folder : path.dirname(dir), 'ensemble.xyz');
    if (fs.existsSync(ens)) {
      md.push(`ensemble.xyz: ${countXyzFrames(fs.readFileSync(ens, 'utf8'))} geometries`, '');
    }
    md.push('| status | count |', '|---|---:|', ...GEOM_STATUSES.map(k => `| ${k} | ${s.byStatus[k].length} |`), `| **total** | ${total} |`, '');
    const t = s.adcTimes;
    if (t.length > 0) {
      md.push(`ADC time: median ${t[Math.floor(t.length / 2)].toFixed(0)} s, min ${t[0].toFixed(0)} s, max ${t[t.length - 1].toFixed(0)} s`, '');
    }
    for (const k of GEOM_STATUSES.filter(k => k !== 'ok' && s.byStatus[k].length > 0)) {
      const links = s.byStatus[k].slice(0, 200).map(g => `[${g}](${vscode.Uri.file(path.join(dir, g, 'run.log')).toString()})`);
      md.push(`**${k}:** ${links.join(' ')}${s.byStatus[k].length > 200 ? ' …' : ''}`, '');
    }
  }
  await showMarkdown(md.join('\n'));
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

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const stem = (p: string) => path.basename(p).replace(/\.[^.]*$/, '');

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
  const rel = (p: string) => q(path.relative(root, p) || '.');
  const args: string[] = [];
  let outName = stem(inputs[0]);
  if (script.label === 'from_geometry.py') {
    const sampling = await vscode.window.showQuickPick(['wigner', 'md'], { title: 'Sampling' });
    if (!sampling) {
      return;
    }
    outName += `_${sampling}`;
    args.push(rel(inputs[0]), '--sampling', sampling, '-n', '1000');
    args.push(...(sampling === 'wigner'
      ? ['--sample-method', 'PBE', '--sample-basis', 'aug-cc-pVDZ', '-T', '300']
      : ['--skip', '0', '--stride', '1', '--beads', '1']));
  } else if (compare) {
    args.push(...inputs.map(p => `${stem(p)}=${rel(p)}`));
    outName = 'compare';
  } else {
    args.push(rel(inputs[0]));
  }
  args.push('-o', q(`runs/${outName}`), '--method', q('adc(3)'), '--basis', 'aug-cc-pVDZ', '--nstates', '2', '-j', '30');
  const cmd = await vscode.window.showInputBox({
    title: `Edit, then Enter to type it into a terminal in ${root} (it is not run)`,
    value: `python scripts/${script.label} ${args.join(' ')}`,
    ignoreFocusOut: true
  });
  if (!cmd) {
    return;
  }
  const term = vscode.window.createTerminal({ name: 'NEA', cwd: root });
  term.show();
  term.sendText(cmd, false);
}
