// "ORCA Runs" explorer view: the optimizations (Opt/OptTS) among the .out
// files in the folder of the active editor, with a verdict read from the log
// itself (normal termination, SCF/opt convergence, imaginary modes, T1/D1) —
// not from exit codes, which ORCA and friends don't set reliably. A toggle
// limits the list to problem runs.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadOutput, naturalCompare } from './io';
import { RunSummary, summarizeRun } from './runSummary';

const VERDICT_ICON: Record<RunSummary['verdict'], [string, string | undefined]> = {
  ok: ['pass', 'testing.iconPassed'],
  'ts-ok': ['pass', 'testing.iconPassed'],
  running: ['sync~spin', undefined],
  failed: ['error', 'testing.iconFailed'],
  saddle: ['warning', 'list.warningForeground'],
  'ts-bad': ['warning', 'list.warningForeground'],
  unknown: ['circle-outline', undefined]
};

const VERDICT_TEXT: Record<RunSummary['verdict'], string> = {
  ok: 'OK',
  'ts-ok': 'TS (1 imag)',
  running: 'running',
  failed: 'failed',
  saddle: 'saddle point',
  'ts-bad': 'TS: wrong # imag',
  unknown: 'no output yet'
};

export class RunItem extends vscode.TreeItem {
  constructor(public readonly outPath: string, public readonly summary: RunSummary | undefined) {
    super(path.basename(outPath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(outPath);
    const v = summary?.verdict ?? 'unknown';
    const [icon, color] = VERDICT_ICON[v];
    this.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    const energy = summary?.energy !== undefined ? ` · ${summary.energy.toFixed(6)} Eh` : '';
    this.description = `${VERDICT_TEXT[v]}${energy}`;
    const lines = [`**${path.basename(outPath)}** — ${VERDICT_TEXT[v]} (${summary?.kind ?? '?'})`];
    if (summary && summary.keywords.length > 0) {
      lines.push('', '`! ' + summary.keywords.join(' ') + '`');
    }
    for (const p of summary?.problems ?? []) {
      lines.push(`- ${p}`);
    }
    this.tooltip = new vscode.MarkdownString(lines.join('\n'));
    this.contextValue = `orcaRun.${v}`;
    this.command = { command: 'vscode.open', title: 'Open', arguments: [this.resourceUri] };
  }
}

export class RunsTreeProvider implements vscode.TreeDataProvider<RunItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RunItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private problemsOnly = false;
  private readonly cache = new Map<string, { mtimeMs: number; summary: RunSummary | undefined }>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private folder: string | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.followActiveEditor()),
      this.emitter
    );
    void vscode.commands.executeCommand('setContext', 'orcaInp.runs.problemsOnly', false);
    this.followActiveEditor();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.watcher?.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  /** Switches the view to the folder of the active file (keeps it when no file editor is active). */
  private followActiveEditor(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      return;
    }
    const folder = path.dirname(uri.fsPath);
    if (folder === this.folder) {
      return;
    }
    this.folder = folder;
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '*.out'));
    this.watcher.onDidChange(() => this.scheduleRefresh());
    this.watcher.onDidCreate(() => this.scheduleRefresh());
    this.watcher.onDidDelete(u => {
      this.cache.delete(u.fsPath);
      this.scheduleRefresh();
    });
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  toggleProblemsOnly(): void {
    this.problemsOnly = !this.problemsOnly;
    void vscode.commands.executeCommand('setContext', 'orcaInp.runs.problemsOnly', this.problemsOnly);
    this.refresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => this.refresh(), 2000);
  }

  private summaryFor(outPath: string): RunSummary | undefined {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(outPath).mtimeMs;
    } catch {
      return undefined;
    }
    const cached = this.cache.get(outPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.summary;
    }
    const parsed = loadOutput(outPath);
    const summary = parsed ? summarizeRun(parsed, vscode.workspace.getConfiguration('orcaInp').get<number>('ts.imagThreshold', -20)) : undefined;
    this.cache.set(outPath, { mtimeMs, summary });
    return summary;
  }

  getTreeItem(item: RunItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<RunItem[]> {
    if (!this.folder) {
      return [new vscode.TreeItem('Open a file to list the optimizations in its folder') as RunItem];
    }
    let outs: string[];
    try {
      outs = fs.readdirSync(this.folder).filter(f => f.endsWith('.out')).sort(naturalCompare).map(f => path.join(this.folder!, f));
    } catch {
      return [];
    }
    const items: RunItem[] = [];
    for (const out of outs) {
      const summary = this.summaryFor(out);
      if (!summary || !['opt', 'optts'].includes(summary.kind)) {
        continue;
      }
      if (this.problemsOnly && ['ok', 'ts-ok'].includes(summary.verdict)) {
        continue;
      }
      items.push(new RunItem(out, summary));
    }
    if (items.length === 0) {
      items.push(new vscode.TreeItem(`No optimizations in ${path.basename(this.folder)}/`) as RunItem);
    }
    return items;
  }
}
