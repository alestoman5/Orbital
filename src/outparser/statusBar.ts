// Minimal Phase 1 wiring: a status bar item that reflects the most
// recently parsed .out file matching the active .inp (or .out) editor's
// basename. Watches **/*.out via vscode.workspace.createFileSystemWatcher
// and re-parses the whole file on change, debounced by ~1.5s. Later phases
// (frequencies/thermo diagnostics, CodeLens, webview, Avogadro hand-off)
// read from the same parsed-output cache via getParsedOutput().

import * as vscode from 'vscode';
import { getOutPathForBasename } from './paths';
import { parseOrcaOutput } from './parse';
import { ParsedOrcaOutput } from './types';

const LANGUAGE_ID = 'orca-inp';
const DEBOUNCE_MS = 1500;

export class OutputStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly parsedByPath = new Map<string, ParsedOrcaOutput>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'ORCA Output Status';
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
      return getOutPathForBasename(doc.uri.fsPath);
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
      this.parsedByPath.set(uri.fsPath, parseOrcaOutput(text));
    } catch {
      // File vanished between the watcher event and the read, or isn't
      // readable yet (still being created) — just drop any stale entry.
      this.parsedByPath.delete(uri.fsPath);
    }
    this.refresh();
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

    const { text, tooltip } = describeStatus(parsed);
    this.item.text = text;
    this.item.tooltip = tooltip;
    this.item.show();
  }
}

function describeStatus(parsed: ParsedOrcaOutput): { text: string; tooltip: string } {
  const lastJob = parsed.jobs[parsed.jobs.length - 1];
  const energy = lastJob?.finalEnergyHartree;
  const energySuffix = energy !== undefined ? ` · E = ${energy.toFixed(6)} Eh` : '';

  switch (parsed.status) {
    case 'running':
      return { text: '$(sync~spin) ORCA: running', tooltip: `ORCA job is still running${energySuffix}` };
    case 'normal-termination':
      return { text: '$(check) ORCA: converged', tooltip: `ORCA finished normally${energySuffix}` };
    case 'error':
      return { text: '$(error) ORCA: failed', tooltip: `ORCA aborted the run${energySuffix}` };
    case 'unknown':
    default:
      return { text: '$(circle-outline) ORCA: idle', tooltip: 'No recognizable ORCA output yet' };
  }
}
