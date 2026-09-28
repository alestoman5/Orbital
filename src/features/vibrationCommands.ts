// Commands around frequencies: nudge a saddle point along its imaginary
// mode, set up an IRC from a TS, export a Molden normal-mode file for
// SHARC's wigner.py, and report whether a minimum is fit for Wigner
// sampling.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hessAtomsToGeometry, VibrationalData } from '../chem/hess';
import {
  assessWignerReadiness,
  buildMolden,
  displaceAlongMode,
  findImaginaryModes,
  vibrationalDataFromJob
} from '../chem/vibrations';
import {
  addSimpleKeywords,
  formatXyz,
  removeSimpleKeywords,
  replaceCoordinatesWithXyzFile
} from '../chem/inputFile';
import { ParsedOrcaOutput } from '../outparser/types';
import { summarizeRun } from './runSummary';
import {
  RunFiles,
  loadHess,
  loadInputText,
  loadOutput,
  openFile,
  runFilesFor,
  showMarkdown,
  targetPath,
  writeWithConfirm
} from './io';

function cfg() {
  return vscode.workspace.getConfiguration('orcaInp');
}

interface LoadedRun {
  files: RunFiles;
  parsed: ParsedOrcaOutput;
  /** Normal-mode data, from .hess if present (exact masses/frame), else from the .out. */
  vib?: VibrationalData;
  vibSource?: '.hess' | '.out';
}

function loadRun(uri?: vscode.Uri): LoadedRun | undefined {
  const p = targetPath(uri);
  if (!p) {
    vscode.window.showErrorMessage('Open an ORCA .inp or .out file first.');
    return undefined;
  }
  const files = runFilesFor(p);
  const parsed = loadOutput(files.out);
  if (!parsed) {
    vscode.window.showErrorMessage(`Cannot read ${path.basename(files.out)}.`);
    return undefined;
  }
  const job = [...parsed.jobs].reverse().find(j => j.frequenciesCm1 && j.frequenciesCm1.length > 0);
  const fromOut = job ? vibrationalDataFromJob(job) : undefined;
  const fromHess = loadHess(files.hess);
  if (fromHess) {
    return { files, parsed, vib: fromHess, vibSource: '.hess' };
  }
  return { files, parsed, vib: fromOut, vibSource: fromOut ? '.out' : undefined };
}

function imagThreshold(): number {
  return cfg().get<number>('ts.imagThreshold', -20);
}

// --- Displace along imaginary mode ---------------------------------------------

export async function displaceAlongImaginaryMode(uri?: vscode.Uri, preset?: 'plus' | 'both'): Promise<void> {
  const run = loadRun(uri);
  if (!run) {
    return;
  }
  const { files, parsed, vib } = run;
  if (!vib) {
    vscode.window.showErrorMessage(
      `No frequencies/normal modes found for ${files.base} (need ${files.base}.hess or VIBRATIONAL FREQUENCIES + NORMAL MODES in the .out).`
    );
    return;
  }
  const imag = findImaginaryModes(vib.frequenciesCm1, imagThreshold());
  if (imag.length === 0) {
    vscode.window.showInformationMessage(`${files.base}: no imaginary modes below ${imagThreshold()} cm⁻¹ — nothing to displace.`);
    return;
  }
  const input = loadInputText(files, parsed);
  if (!input) {
    vscode.window.showErrorMessage(`Neither ${files.base}.inp nor an input echo in the .out was found.`);
    return;
  }

  let direction = preset;
  if (!direction) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '+ direction', description: `${files.base}_disp.inp`, value: 'plus' as const },
        { label: '± both directions', description: `${files.base}_disp_plus.inp + ${files.base}_disp_minus.inp`, value: 'both' as const }
      ],
      { title: `Displace along ${imag[0].freq.toFixed(2)} cm⁻¹ (mode ${imag[0].index})` }
    );
    if (!pick) {
      return;
    }
    direction = pick.value;
  }

  const maxDisp = cfg().get<number>('ts.maxDisplacement', 0.15);
  const geometry = hessAtomsToGeometry(vib.atoms);
  const mode = vib.normalModes[imag[0].index];
  const variants: { suffix: string; sign: 1 | -1 }[] =
    direction === 'both' ? [{ suffix: '_disp_plus', sign: 1 }, { suffix: '_disp_minus', sign: -1 }] : [{ suffix: '_disp', sign: 1 }];

  let text = input.text;
  const gbw = path.join(files.dir, `${files.base}.gbw`);
  const useMoread = cfg().get<boolean>('ts.useMoread', false) && fs.existsSync(gbw);

  const written: string[] = [];
  for (const v of variants) {
    const name = `${files.base}${v.suffix}`;
    const displaced = displaceAlongMode(geometry, mode, maxDisp, v.sign);
    const comment = `${files.base}: displaced ${v.sign > 0 ? '+' : '-'}${maxDisp} A along mode ${imag[0].index} (${imag[0].freq.toFixed(2)} cm-1)`;
    let inp = replaceCoordinatesWithXyzFile(text, `${name}.xyz`);
    if (useMoread) {
      inp = addSimpleKeywords(inp, ['MORead']);
      inp = inp.replace(/(\n\* xyzfile)/, `\n%moinp "${files.base}.gbw"$1`);
    }
    inp = `# ${comment}\n` + inp;
    const xyzPath = path.join(files.dir, `${name}.xyz`);
    const inpPath = path.join(files.dir, `${name}.inp`);
    if (!(await writeWithConfirm(xyzPath, formatXyz(displaced, comment)))) {
      return;
    }
    if (!(await writeWithConfirm(inpPath, inp))) {
      return;
    }
    written.push(inpPath);
  }
  const extra = imag.length > 1 ? ` (${imag.length} imaginary modes — displaced along the lowest; re-check after the new run)` : '';
  const echoNote = input.fromEcho ? ' Input rebuilt from the .out echo — check it.' : '';
  vscode.window.showInformationMessage(`Created ${written.map(p => path.basename(p)).join(', ')}${extra}.${echoNote}`);
  await openFile(written[0]);
}

// --- IRC from a TS --------------------------------------------------------------

export async function createIrcInput(uri?: vscode.Uri): Promise<void> {
  const run = loadRun(uri);
  if (!run) {
    return;
  }
  const { files, parsed } = run;
  const summary = summarizeRun(parsed, imagThreshold());
  if (summary.imaginary.length !== 1) {
    const go = await vscode.window.showWarningMessage(
      `${files.base} has ${summary.imaginary.length} imaginary modes; an IRC needs a TS with exactly one. Continue anyway?`,
      'Continue'
    );
    if (go !== 'Continue') {
      return;
    }
  }
  const input = loadInputText(files, parsed);
  if (!input) {
    vscode.window.showErrorMessage(`Neither ${files.base}.inp nor an input echo in the .out was found.`);
    return;
  }
  const name = `${files.base}_irc`;
  const tsXyz = path.join(files.dir, `${files.base}_ts.xyz`);
  const geom = [...parsed.jobs].reverse().find(j => j.finalGeometry)?.finalGeometry;
  if (!geom) {
    vscode.window.showErrorMessage(`No final geometry in ${path.basename(files.out)}.`);
    return;
  }
  if (!(await writeWithConfirm(tsXyz, formatXyz(geom, `${files.base}: final (TS) geometry`)))) {
    return;
  }
  let inp = removeSimpleKeywords(input.text, [
    'OPTTS', 'OPT', 'NORMALOPT', 'LOOSEOPT', 'TIGHTOPT', 'VERYTIGHTOPT', 'COPT', 'FREQ', 'NUMFREQ', 'ANFREQ', 'SCANTS'
  ]);
  inp = addSimpleKeywords(inp, ['IRC']);
  inp = replaceCoordinatesWithXyzFile(inp, path.basename(tsXyz));
  if (fs.existsSync(files.hess)) {
    inp = inp.replace(/(\n\* xyzfile)/, `\n%irc\n  InitHess read\n  Hess_Filename "${files.base}.hess"\n  MaxIter 100\nend$1`);
  }
  inp = `# IRC from the TS of ${files.base}\n` + inp;
  const inpPath = path.join(files.dir, `${name}.inp`);
  if (await writeWithConfirm(inpPath, inp)) {
    await openFile(inpPath);
  }
}

// --- Molden export ----------------------------------------------------------------

export async function exportMolden(uri?: vscode.Uri): Promise<void> {
  const p = targetPath(uri);
  if (!p) {
    vscode.window.showErrorMessage('Open an ORCA .inp or .out file first.');
    return;
  }
  const files = runFilesFor(p);
  const parsed = loadOutput(files.out);
  // Prefer the .out: it reproduces SHARC's ORCA_freq.py output exactly
  // (same bohr coordinates, 6-decimal modes, IR eps in [INT]).
  const job = parsed ? [...parsed.jobs].reverse().find(j => j.frequenciesCm1 && j.normalModes) : undefined;
  let vib = job ? vibrationalDataFromJob(job) : undefined;
  let intensities = job?.irEpsilon;
  let source = path.basename(files.out);
  if (!vib) {
    vib = loadHess(files.hess);
    intensities = undefined;
    source = path.basename(files.hess);
  }
  if (!vib) {
    vscode.window.showErrorMessage(`No normal modes found for ${files.base} (.out without NORMAL MODES and no readable .hess).`);
    return;
  }
  const imag = findImaginaryModes(vib.frequenciesCm1, imagThreshold());
  if (imag.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${files.base} is a saddle point (${imag.map(m => m.freq.toFixed(2)).join(', ')} cm⁻¹). Wigner sampling needs a minimum.`,
      'Displace and re-optimize',
      'Export anyway'
    );
    if (choice === 'Displace and re-optimize') {
      await displaceAlongImaginaryMode(vscode.Uri.file(files.out));
      return;
    }
    if (choice !== 'Export anyway') {
      return;
    }
  }
  const outPath = path.join(files.dir, `${files.base}.molden`);
  if (await writeWithConfirm(outPath, buildMolden(vib, intensities))) {
    vscode.window.showInformationMessage(
      `Wrote ${path.basename(outPath)} from ${source} — e.g. wigner.py -n 1000 -t 300 -x ${path.basename(outPath)}`
    );
  }
}

// --- Wigner readiness report ----------------------------------------------------------

export function wignerReportMarkdown(name: string, parsed: ParsedOrcaOutput, temperatureK: number): string {
  const job = [...parsed.jobs].reverse().find(j => j.frequenciesCm1 && j.frequenciesCm1.length > 0);
  const geom = job?.finalGeometry ?? [...parsed.jobs].reverse().find(j => j.finalGeometry)?.finalGeometry;
  if (!job || !geom) {
    return `# Wigner readiness: ${name}\n\nNo VIBRATIONAL FREQUENCIES found — run Opt + Freq first.\n`;
  }
  const r = assessWignerReadiness(geom, job.frequenciesCm1!, {
    temperatureK,
    imagThreshold: vscode.workspace.getConfiguration('orcaInp').get<number>('ts.imagThreshold', -20),
    softThreshold: vscode.workspace.getConfiguration('orcaInp').get<number>('wigner.softModeThreshold', 200),
    terminatedNormally: parsed.status === 'normal-termination'
  });
  const out: string[] = [];
  out.push(`# Wigner readiness: ${name}`, '');
  out.push(r.ok ? '**Ready** — a true minimum with the expected number of modes.' : '**Not ready.**', '');
  for (const p of r.problems) out.push(`- ❌ ${p}`);
  for (const w of r.warnings) out.push(`- ⚠️ ${w}`);
  out.push('', `${r.nAtoms} atoms, ${r.linear ? 'linear' : 'non-linear'}: expected ${r.expectedModes} modes, found ${r.foundModes}.`, '');
  out.push(`## Modes at ${temperatureK} K`, '');
  out.push('Quantum/classical ratio = x·coth x, x = ħω/2kT: how much wider the Wigner distribution is than the classical one.', '');
  out.push('| mode | ν̃ / cm⁻¹ | quantum/classical ⟨q²⟩ | note |', '|---:|---:|---:|---|');
  for (const m of r.modes) {
    out.push(`| ${m.index} | ${m.freq.toFixed(2)} | ${m.ratio.toFixed(2)} | ${m.soft ? 'soft — check anharmonicity' : ''} |`);
  }
  for (const m of r.imaginary) {
    out.push(`| ${m.index} | ${m.freq.toFixed(2)} | — | imaginary |`);
  }
  return out.join('\n') + '\n';
}

export async function showWignerReport(uri?: vscode.Uri): Promise<void> {
  const p = targetPath(uri);
  if (!p) {
    vscode.window.showErrorMessage('Open an ORCA .inp or .out file first.');
    return;
  }
  const files = runFilesFor(p);
  const parsed = loadOutput(files.out);
  if (!parsed) {
    vscode.window.showErrorMessage(`Cannot read ${path.basename(files.out)}.`);
    return;
  }
  const T = cfg().get<number>('wigner.temperature', 300);
  await showMarkdown(wignerReportMarkdown(path.basename(files.out), parsed, T));
}
