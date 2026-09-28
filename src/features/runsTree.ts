// "ORCA Runs" explorer view: every .out file in the workspace with a verdict
// read from the log itself (normal termination, SCF/opt convergence,
// imaginary modes, T1/D1) — not from exit codes, which ORCA and friends
// don't set reliably. A toggle limits the list to problem runs.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findOutFiles, loadOutput } from './io';
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
  constructor(public readonly outPath: string, public readonly summary: RunSummary | undefined, root: string | undefined) {
    super(root ? path.relative(root, outPath) : path.basename(outPath), vscode.TreeItemCollapsibleState.None);
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

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.out');
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidDelete(uri => {
        this.cache.delete(uri.fsPath);
        this.scheduleRefresh();
      }),
      this.emitter
    );
    void vscode.commands.executeCommand('setContext', 'orcaInp.runs.problemsOnly', false);
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.disposables.forEach(d => d.dispose());
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
    const maxFiles = vscode.workspace.getConfiguration('orcaInp').get<number>('runs.maxFiles', 500);
    const outs = await findOutFiles();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const items: RunItem[] = [];
    for (const out of outs.slice(0, maxFiles)) {
      const summary = this.summaryFor(out);
      const bad = !summary || !['ok', 'ts-ok'].includes(summary.verdict);
      if (this.problemsOnly && !bad) {
        continue;
      }
      items.push(new RunItem(out, summary, root));
    }
    if (outs.length > maxFiles) {
      const more = new vscode.TreeItem(`… ${outs.length - maxFiles} more .out files (raise orcaInp.runs.maxFiles)`);
      items.push(more as RunItem);
    }
    return items;
  }
}
