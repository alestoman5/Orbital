// Minimal Phase 1 wiring: a status bar item that reflects the most
// recently parsed .out file matching the active .inp (or .out) editor's
// basename. Watches **/*.out via vscode.workspace.createFileSystemWatcher
// and re-parses the whole file on change, debounced by ~1.5s. Later phases
// (frequencies/thermo diagnostics, CodeLens, webview, Avogadro hand-off)
// read from the same parsed-output cache via getParsedOutput().

import * as path from 'path';
import * as vscode from 'vscode';
import { parseOrcaOutput } from './parse';
import { ParsedOrcaOutput } from './types';
import { T1_THRESHOLD, summarizeRun } from '../features/runSummary';
import { runFilesFor } from '../features/io';

const LANGUAGE_ID = 'orca-inp';
const DEBOUNCE_MS = 1500;

export class OutputStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly parsedByPath = new Map<string, ParsedOrcaOutput>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly prompted = new Set<string>();

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'ORCA Output Status';
    this.item.command = 'orcaInp.runActions';
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.out');

    this.disposables.push(
      this.item,
      this.watcher,
      this.watcher.onDidChange(uri => this.scheduleReparse(uri)),
      this.watcher.onDidCreate(uri => this.scheduleReparse(uri)),
      this.watcher.onDidDelete(uri => this.handleDelete(uri)),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh())
    );

    this.primeActiveEditor();
    this.refresh();
  }

  /** Exposed for later phases (CodeLens, Avogadro hand-off, webview summary). */
  getParsedOutput(outPath: string): ParsedOrcaOutput | undefined {
    return this.parsedByPath.get(outPath);
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private primeActiveEditor(): void {
    const outPath = this.activeOutPath();
    if (outPath) {
      void this.reparse(vscode.Uri.file(outPath));
    }
  }

  private activeOutPath(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const doc = editor.document;
    if (doc.languageId === LANGUAGE_ID) {
      return runFilesFor(doc.uri.fsPath).out; // job.out, or job.inp.out when that is what exists
    }
    if (doc.uri.fsPath.toLowerCase().endsWith('.out')) {
      return doc.uri.fsPath;
    }
    return undefined;
  }

  private scheduleReparse(uri: vscode.Uri): void {
    const key = uri.fsPath;
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.reparse(uri);
    }, DEBOUNCE_MS);
    this.debounceTimers.set(key, timer);
  }

  private async reparse(uri: vscode.Uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = parseOrcaOutput(text);
      this.parsedByPath.set(uri.fsPath, parsed);
      this.maybePrompt(uri.fsPath, parsed);
    } catch {
      // File vanished between the watcher event and the read, or isn't
      // readable yet (still being created) — just drop any stale entry.
      this.parsedByPath.delete(uri.fsPath);
    }
    this.refresh();
  }

  /**
   * Once per file and verdict per session: offer the obvious next step when
   * a run finishes as a saddle point (displace and re-optimize) or as a
   * clean TS (set up an IRC).
   */
  private maybePrompt(outPath: string, parsed: ParsedOrcaOutput): void {
    const config = vscode.workspace.getConfiguration('orcaInp');
    if (!config.get<boolean>('ts.autoPrompt', true)) {
      return;
    }
    const s = summarizeRun(parsed, config.get<number>('ts.imagThreshold', -20));
    const key = `${outPath}|${s.verdict}`;
    if (this.prompted.has(key)) {
      return;
    }
    const uri = vscode.Uri.file(outPath);
    const name = path.basename(outPath);
    if (s.verdict === 'saddle' && s.kind === 'opt') {
      this.prompted.add(key);
      void vscode.window
        .showWarningMessage(
          `${name}: the optimization ended at a saddle point (${s.imaginary.map(m => m.freq.toFixed(1)).join(', ')} cm⁻¹). Displace along the imaginary mode and re-optimize?`,
          'Create displaced input',
          'Both directions (±)'
        )
        .then(choice => {
          if (choice === 'Create displaced input') {
            void vscode.commands.executeCommand('orcaInp.displaceAlongImaginaryMode', uri, 'plus');
          } else if (choice === 'Both directions (±)') {
            void vscode.commands.executeCommand('orcaInp.displaceAlongImaginaryMode', uri, 'both');
          }
        });
    } else if (s.verdict === 'ts-ok' && s.hasFrequencies) {
      this.prompted.add(key);
      void vscode.window
        .showInformationMessage(`${name}: TS found (${s.imaginary[0].freq.toFixed(1)} cm⁻¹). Create an IRC input?`, 'Create IRC input')
        .then(choice => {
          if (choice) {
            void vscode.commands.executeCommand('orcaInp.createIrcInput', uri);
          }
        });
    } else if (s.verdict === 'ts-bad') {
      this.prompted.add(key);
      void vscode.window.showWarningMessage(`${name}: ${s.problems.join('; ')}.`);
    }
  }

  private handleDelete(uri: vscode.Uri): void {
    this.parsedByPath.delete(uri.fsPath);
    const timer = this.debounceTimers.get(uri.fsPath);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(uri.fsPath);
    }
    this.refresh();
  }

  private refresh(): void {
    const outPath = this.activeOutPath();
    const parsed = outPath ? this.parsedByPath.get(outPath) : undefined;
    if (!parsed) {
      this.item.hide();
      return;
    }

    const { text, tooltip } = describeStatus(parsed, vscode.workspace.getConfiguration('orcaInp').get<number>('ts.imagThreshold', -20));
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.show();
  }
}

export function describeStatus(parsed: ParsedOrcaOutput, imagThreshold = -20): { text: string; tooltip: string } {
  const s = summarizeRun(parsed, imagThreshold);
  const energySuffix = s.energy !== undefined ? ` · E = ${s.energy.toFixed(6)} Eh` : '';
  const problems = s.problems.length > 0 ? `\n${s.problems.map(p => `• ${p}`).join('\n')}` : '';
  const diag = s.t1 !== undefined && s.t1 > T1_THRESHOLD ? ` · T1 ${s.t1.toFixed(3)}` : '';

  switch (s.verdict) {
    case 'running':
      return { text: '$(sync~spin) ORCA: running', tooltip: `ORCA job is still running${energySuffix}` };
    case 'failed':
      return { text: '$(error) ORCA: failed', tooltip: `ORCA run failed${energySuffix}${problems}` };
    case 'saddle': {
      const n = s.imaginary.length;
      return {
        text: `$(warning) ORCA: saddle point (${n} imag, ${s.imaginary[0].freq.toFixed(0)} cm⁻¹)`,
        tooltip: `Finished, but not a minimum${energySuffix}${problems}\nClick for actions (displace along the imaginary mode).`
      };
    }
    case 'ts-ok':
      return {
        text: `$(check) ORCA: TS${s.hasFrequencies ? ` (${s.imaginary[0]?.freq.toFixed(0)} cm⁻¹)` : ''}${diag}`,
        tooltip: `Transition-state search finished${energySuffix}${problems}\nClick for actions (IRC input).`
      };
    case 'ts-bad':
      return { text: `$(warning) ORCA: TS with ${s.imaginary.length} imag`, tooltip: `A TS needs exactly one imaginary mode${energySuffix}${problems}` };
    case 'ok':
      return {
        text: `$(check) ORCA: ${s.hasFrequencies ? 'minimum' : 'converged'}${diag}`,
        tooltip: `ORCA finished normally${s.hasFrequencies ? ', no imaginary modes' : ''}${energySuffix}${problems}`
      };
    case 'unknown':
    default:
      return { text: '$(circle-outline) ORCA: idle', tooltip: 'No recognizable ORCA output yet' };
  }
}
