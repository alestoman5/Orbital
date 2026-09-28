// Small filesystem helpers shared by the VS Code commands: resolve the .out
// / .hess / .inp that belong to whatever file the user invoked a command
// on, load + parse them, and write result files next to them.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseOrcaOutput } from '../outparser/parse';
import { ParsedOrcaOutput } from '../outparser/types';
import { parseHessFile, VibrationalData } from '../chem/hess';

export interface RunFiles {
  dir: string;
  base: string;
  out: string;
  hess: string;
  inp: string;
}

/**
 * Sibling paths for a job. ORCA names outputs after the input basename, but
 * people commonly redirect to "job.inp.out" as well as "job.out" — both
 * spellings are recognized.
 */
export function runFilesFor(anyPath: string): RunFiles {
  const dir = path.dirname(anyPath);
  let name = path.basename(anyPath);
  if (/\.inp\.out$/i.test(name)) {
    name = name.slice(0, -'.inp.out'.length);
  } else {
    name = name.slice(0, name.length - path.extname(name).length);
  }
  const outCandidates = [path.join(dir, `${name}.out`), path.join(dir, `${name}.inp.out`)];
  const out = /\.out$/i.test(anyPath) ? anyPath : outCandidates.find(p => fs.existsSync(p)) ?? outCandidates[0];
  return {
    dir,
    base: name,
    out,
    hess: path.join(dir, `${name}.hess`),
    inp: path.join(dir, `${name}.inp`)
  };
}

/** Path of the file the command should act on: explicit URI arg, else the active editor. */
export function targetPath(uri?: vscode.Uri): string | undefined {
  if (uri instanceof vscode.Uri) {
    return uri.fsPath;
  }
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

export function loadOutput(outPath: string): ParsedOrcaOutput | undefined {
  try {
    return parseOrcaOutput(fs.readFileSync(outPath, 'utf8'));
  } catch {
    return undefined;
  }
}

export function loadHess(hessPath: string): VibrationalData | undefined {
  try {
    return parseHessFile(fs.readFileSync(hessPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The input text for a run: the .inp next to it if present, otherwise the
 * deck ORCA echoed into the .out.
 */
export function loadInputText(files: RunFiles, parsed?: ParsedOrcaOutput): { text: string; fromEcho: boolean } | undefined {
  if (fs.existsSync(files.inp)) {
    return { text: fs.readFileSync(files.inp, 'utf8'), fromEcho: false };
  }
  if (parsed && parsed.inputEcho.length > 0) {
    // ORCA appends an empty line and sometimes "****END OF INPUT****" — cut there.
    const end = parsed.inputEcho.findIndex(l => /END OF INPUT/i.test(l));
    const lines = end >= 0 ? parsed.inputEcho.slice(0, end) : parsed.inputEcho;
    return { text: lines.join('\n').trimEnd() + '\n', fromEcho: true };
  }
  return undefined;
}

/** Writes a file, asking before overwriting an existing one. Returns false if the user declined. */
export async function writeWithConfirm(filePath: string, content: string): Promise<boolean> {
  if (fs.existsSync(filePath)) {
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(filePath)} already exists. Overwrite?`,
      { modal: true },
      'Overwrite'
    );
    if (choice !== 'Overwrite') {
      return false;
    }
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

export async function openFile(filePath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

export async function showMarkdown(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri).then(undefined, () => undefined);
}

/** Natural sort ("geom_2" before "geom_10"). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * .out files under a folder (or the whole workspace), naturally sorted.
 * Honors the orcaInp.runs.exclude glob.
 */
export async function findOutFiles(folder?: vscode.Uri, pattern = '**/*.out'): Promise<string[]> {
  const exclude = vscode.workspace.getConfiguration('orcaInp').get<string>('runs.exclude', '**/{node_modules,.git}/**');
  const include = folder ? new vscode.RelativePattern(folder, pattern) : pattern;
  const uris = await vscode.workspace.findFiles(include, exclude);
  return uris.map(u => u.fsPath).sort(naturalCompare);
}

export async function pickFolder(title: string): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
  });
  return picked?.[0];
}
