// Commands that work on a set of runs: basis-set variants of one input,
// a geometry comparison table across outputs, PyNEAppLES export of a batch
// of excited-state runs, and Boltzmann weights of conformers.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isOrbitalBasis } from '../semantic';
import {
  addSimpleKeywords,
  parseOrcaInput,
  removeSimpleKeywords,
  replaceSimpleKeyword
} from '../chem/inputFile';
import { measure, parseWatchSpec, unitOf } from '../chem/geometry';
import { boltzmannWeights, buildPyneapplesInput } from '../chem/spectrum';
import { HARTREE_TO_KCALMOL } from '../chem/elements';
import { summarizeRun } from './runSummary';
import { findOutFiles, loadOutput, openFile, pickFolder, showMarkdown, targetPath, writeWithConfirm } from './io';

function cfg() {
  return vscode.workspace.getConfiguration('orcaInp');
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9+_-]+/g, '_');
}

// --- Basis-set variants -----------------------------------------------------------

export async function createBasisVariants(uri?: vscode.Uri): Promise<void> {
  const p = targetPath(uri);
  if (!p || !/\.inp$/i.test(p)) {
    vscode.window.showErrorMessage('Run this on an ORCA .inp file.');
    return;
  }
  const text = fs.readFileSync(p, 'utf8');
  const input = parseOrcaInput(text);
  const current = input.keywords.filter(isOrbitalBasis);
  if (current.length !== 1) {
    vscode.window.showErrorMessage(
      current.length === 0
        ? 'No orbital basis set found on the "!" line (a %basis block is not supported here).'
        : `Several basis sets on the "!" line (${current.join(', ')}) — keep just one.`
    );
    return;
  }
  const defaults = cfg().get<string[]>('variants.basisSets', ['aug-cc-pVDZ', 'def2-SVPD', 'ma-def2-SVP', 'def2-SVP']);
  const picks = await vscode.window.showQuickPick(
    [
      ...defaults.map(b => ({ label: b, picked: true, variant: 'basis' as const })),
      { label: 'Tight variant', description: 'extra copy with VeryTightOpt / VeryTightSCF', picked: false, variant: 'tight' as const }
    ],
    { canPickMany: true, title: `Variants of ${path.basename(p)} (current basis: ${current[0]})` }
  );
  if (!picks || picks.length === 0) {
    return;
  }
  const bases = picks.filter(x => x.variant === 'basis').map(x => x.label);
  const tight = picks.some(x => x.variant === 'tight');
  if (bases.length === 0) {
    bases.push(current[0]);
  }

  const dir = path.dirname(p);
  const base = path.basename(p, path.extname(p));
  const xyz = input.coords?.file;
  const created: string[] = [];
  for (const basis of bases) {
    const flavors: { tag: string; tight: boolean }[] = [{ tag: '', tight: false }];
    if (tight) {
      flavors.push({ tag: '_tight', tight: true });
    }
    for (const fl of flavors) {
      const sub = path.join(dir, `${base}_${sanitize(basis)}${fl.tag}`);
      fs.mkdirSync(sub, { recursive: true });
      let out = replaceSimpleKeyword(text, current[0], basis).text;
      if (fl.tight) {
        out = removeSimpleKeywords(out, ['OPT', 'NORMALOPT', 'LOOSEOPT', 'TIGHTOPT', 'NORMALSCF', 'LOOSESCF', 'TIGHTSCF', 'STRONGSCF']);
        const hadOpt = parseOrcaInput(text).keywords.some(k => /^(NORMAL|LOOSE|TIGHT|VERYTIGHT)?OPT$/i.test(k));
        out = addSimpleKeywords(out, hadOpt ? ['VeryTightOpt', 'VeryTightSCF'] : ['VeryTightSCF']);
      }
      const target = path.join(sub, `${base}.inp`);
      if (!(await writeWithConfirm(target, out))) {
        return;
      }
      if (xyz && !path.isAbsolute(xyz) && fs.existsSync(path.join(dir, xyz))) {
        fs.copyFileSync(path.join(dir, xyz), path.join(sub, path.basename(xyz)));
      }
      created.push(path.relative(dir, target));
    }
  }
  vscode.window.showInformationMessage(`Created ${created.length} input(s): ${created.join(', ')}`);
}

// --- Geometry comparison ---------------------------------------------------------------

function watchSpecs(folder: string): string[] {
  const file = path.join(folder, '.orca-watch.json');
  if (fs.existsSync(file)) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(json)) {
        return json.map(String);
      }
      if (Array.isArray(json.coordinates)) {
        return json.coordinates.map(String);
      }
    } catch {
      vscode.window.showWarningMessage('.orca-watch.json is not valid JSON — falling back to orcaInp.watchedCoordinates.');
    }
  }
  return cfg().get<string[]>('watchedCoordinates', []);
}

export async function compareGeometries(uri?: vscode.Uri): Promise<void> {
  const folder = uri && fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory() ? uri : await pickFolder('Folder with ORCA .out files');
  if (!folder) {
    return;
  }
  let specs = watchSpecs(folder.fsPath);
  if (specs.length === 0) {
    const typed = await vscode.window.showInputBox({
      title: 'Coordinates to compare (1-based atom indices)',
      value: 'O-O: 2-3, C-O: 1-2, C-O-O: 1-2-3',
      prompt: 'Comma-separated "label: i-j[-k[-l]]". Save them in .orca-watch.json or orcaInp.watchedCoordinates to skip this prompt.'
    });
    if (!typed) {
      return;
    }
    // Split on commas that start a new "label:" entry.
    specs = typed.split(/\s*,\s*(?=[^,:]+:)/).map(s => s.trim()).filter(s => s.length > 0);
  }
  const { coords, errors } = parseWatchSpec(specs);
  if (errors.length > 0) {
    vscode.window.showErrorMessage(errors.join(' '));
    return;
  }
  const outs = await findOutFiles(folder);
  if (outs.length === 0) {
    vscode.window.showInformationMessage('No .out files in that folder.');
    return;
  }
  const header = ['run', 'status', 'E / Eh', ...coords.map(c => `${c.label} / ${unitOf(c)}`)];
  const rows: string[][] = [];
  for (const out of outs) {
    const parsed = loadOutput(out);
    if (!parsed) {
      continue;
    }
    const s = summarizeRun(parsed);
    const geom = [...parsed.jobs].reverse().find(j => j.finalGeometry)?.finalGeometry;
    rows.push([
      path.relative(folder.fsPath, out),
      s.verdict,
      s.energy !== undefined ? s.energy.toFixed(8) : '',
      ...coords.map(c => {
        const v = geom ? measure(geom, c) : undefined;
        return v === undefined ? '' : v.toFixed(c.atoms.length === 2 ? 4 : 2);
      })
    ]);
  }
  const csvPath = path.join(folder.fsPath, 'geometry_comparison.csv');
  const csv = [header, ...rows].map(r => r.map(x => (/[",]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(',')).join('\n') + '\n';
  fs.writeFileSync(csvPath, csv, 'utf8');
  const md = [
    `# Geometry comparison — ${path.basename(folder.fsPath)}`,
    '',
    `Final geometries of ${rows.length} run(s). CSV: \`${csvPath}\``,
    '',
    `| ${header.join(' | ')} |`,
    `|${header.map((_, i) => (i < 2 ? '---' : '---:')).join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`)
  ].join('\n');
  await showMarkdown(md + '\n');
}

// --- PyNEAppLES export ---------------------------------------------------------------------

export async function exportPyneapples(uri?: vscode.Uri): Promise<void> {
  const folder = uri && fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory() ? uri : await pickFolder('Folder with excited-state .out files (one per geometry)');
  if (!folder) {
    return;
  }
  const pattern = cfg().get<string>('pyneapples.pattern', '**/*.out');
  const outs = await findOutFiles(folder, pattern);
  if (outs.length === 0) {
    vscode.window.showInformationMessage(`No files matching ${pattern} in that folder.`);
    return;
  }
  const runs = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reading ${outs.length} ORCA outputs…` },
    async () =>
      outs.map(out => {
        const parsed = loadOutput(out);
        const job = parsed ? [...parsed.jobs].reverse().find(j => j.excitations && j.excitations.length > 0) : undefined;
        return {
          name: path.relative(folder.fsPath, out),
          ok: parsed?.status === 'normal-termination',
          status: parsed?.status ?? 'unknown',
          excitations: job?.excitations
        };
      })
  );
  // Most common number of transitions = default state count.
  const counts = new Map<number, number>();
  for (const r of runs) {
    if (r.excitations) {
      counts.set(r.excitations.length, (counts.get(r.excitations.length) ?? 0) + 1);
    }
  }
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (common === undefined) {
    vscode.window.showErrorMessage('None of the outputs contains an ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS table.');
    return;
  }
  const nStr = await vscode.window.showInputBox({
    title: 'Number of excited states per geometry (-N)',
    value: String(common),
    validateInput: v => (/^\d+$/.test(v) && parseInt(v, 10) > 0 ? undefined : 'positive integer')
  });
  if (!nStr) {
    return;
  }
  const nStates = parseInt(nStr, 10);
  const result = buildPyneapplesInput(runs, nStates);
  const target = path.join(folder.fsPath, 'pyneapples_input.txt');
  if (!(await writeWithConfirm(target, result.text))) {
    return;
  }
  const cmd = `python calc_spectrum_v2.py pyneapples_input.txt -n ${result.nUsed} -N ${nStates} -a silverman -e 0.95 --ealg bootstrap -D`;
  const md = [
    `# PyNEAppLES export — ${path.basename(folder.fsPath)}`,
    '',
    `- **${result.nUsed}** geometries used (${outs.length} files found, ${result.skipped.length} skipped)`,
    `- states per geometry: ${nStates}`,
    `- file: \`${target}\``,
    '',
    'Run with `-n` equal to the number of geometries actually used — otherwise the absolute cross section is silently mis-normalized:',
    '',
    '```',
    cmd,
    '```',
    '',
    'For correlated MD/PIMD snapshots use `--ealg cbb` instead of `bootstrap`.',
    ''
  ];
  if (result.skipped.length > 0) {
    md.push('## Skipped', '', '| file | reason |', '|---|---|', ...result.skipped.map(s => `| ${s.name} | ${s.reason} |`));
  }
  await showMarkdown(md.join('\n') + '\n');
}

// --- Boltzmann weights ------------------------------------------------------------------------

export async function boltzmannWeightsCommand(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  let files = (uris && uris.length > 1 ? uris : undefined)?.map(u => u.fsPath).filter(f => /\.out$/i.test(f));
  if (!files || files.length < 2) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { 'ORCA output': ['out'] },
      title: 'Select the Freq outputs of all conformers',
      defaultUri: uri ?? vscode.workspace.workspaceFolders?.[0]?.uri
    });
    files = picked?.map(u => u.fsPath);
  }
  if (!files || files.length < 2) {
    return;
  }
  const T = cfg().get<number>('boltzmann.temperature', 298.15);
  const rows: { name: string; g: number }[] = [];
  const missing: string[] = [];
  for (const f of files) {
    const parsed = loadOutput(f);
    const g = parsed ? [...parsed.jobs].reverse().find(j => j.thermo?.gibbs !== undefined)?.thermo?.gibbs : undefined;
    if (g === undefined) {
      missing.push(path.basename(f));
    } else {
      rows.push({ name: path.basename(f), g });
    }
  }
  if (rows.length < 2) {
    vscode.window.showErrorMessage(`Need at least two outputs with "Final Gibbs free energy" (missing in: ${missing.join(', ')}).`);
    return;
  }
  const w = boltzmannWeights(rows.map(r => r.g), T);
  const gMin = Math.min(...rows.map(r => r.g));
  const order = rows.map((r, i) => ({ ...r, w: w[i] })).sort((a, b) => a.g - b.g);
  const dir = path.dirname(files[0]);
  const csvPath = path.join(dir, 'boltzmann_weights.csv');
  fs.writeFileSync(
    csvPath,
    ['file,G_Eh,dG_kcal_mol,weight', ...order.map(r => `${r.name},${r.g.toFixed(8)},${((r.g - gMin) * HARTREE_TO_KCALMOL).toFixed(3)},${r.w.toFixed(6)}`)].join('\n') + '\n',
    'utf8'
  );
  const md = [
    `# Boltzmann populations at ${T} K`,
    '',
    'w ∝ exp(−G/kT). Combine conformer spectra as σ(E) = Σ w_c σ_c(E).',
    '',
    '| file | G / Eh | ΔG / kcal·mol⁻¹ | weight |',
    '|---|---:|---:|---:|',
    ...order.map(r => `| ${r.name} | ${r.g.toFixed(8)} | ${((r.g - gMin) * HARTREE_TO_KCALMOL).toFixed(2)} | ${(100 * r.w).toFixed(1)} % |`),
    '',
    `CSV: \`${csvPath}\``
  ];
  if (missing.length > 0) {
    md.push('', `Skipped (no Gibbs energy): ${missing.join(', ')}`);
  }
  await showMarkdown(md.join('\n') + '\n');
}

export { openFile };
