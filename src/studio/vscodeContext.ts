// HostContext implemented with the VS Code API (see context.ts for the
// contract; webview/dev/server.mjs has the plain-Node twin).

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Disposable, FindFilesOptions, HostContext } from './context';
import type { TabId } from './protocol';
import { naturalCompare } from '../features/io';

export interface PanelHooks {
  post(channel: TabId | 'studio', name: string, payload?: unknown): void;
  navigate(tab: TabId, args?: unknown): void;
}

let output: vscode.OutputChannel | undefined;
function log(message: string): void {
  output ??= vscode.window.createOutputChannel('Orbital Studio');
  output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

export function createVscodeContext(tab: TabId, extensionPath: string, hooks: PanelHooks): HostContext {
  return {
    tab,
    extensionPath,
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    storageDir() {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        return undefined;
      }
      const dir = path.join(root, '.orbital');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    config: <T>(key: string, fallback: T) => vscode.workspace.getConfiguration('orcaInp').get<T>(key, fallback),
    async findFiles(include: string, options: FindFilesOptions = {}) {
      const exclude = options.exclude ?? vscode.workspace.getConfiguration('orcaInp').get<string>('runs.exclude', '**/{node_modules,.git}/**');
      const pattern = options.base ? new vscode.RelativePattern(vscode.Uri.file(options.base), include) : include;
      const uris = await vscode.workspace.findFiles(pattern, exclude, options.max);
      return uris.map(u => u.fsPath).sort(naturalCompare);
    },
    watch(include: string, onChange: (p: string) => void, base?: string): Disposable {
      const pattern = base ? new vscode.RelativePattern(vscode.Uri.file(base), include) : include;
      const w = vscode.workspace.createFileSystemWatcher(pattern);
      const fire = (u: vscode.Uri) => onChange(u.fsPath);
      w.onDidChange(fire);
      w.onDidCreate(fire);
      w.onDidDelete(fire);
      return w;
    },
    post: (name, payload) => hooks.post(tab, name, payload),
    navigate: (target, args) => hooks.navigate(target, args),
    async saveFile(params) {
      let target = params.path;
      if (!target) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const uri = await vscode.window.showSaveDialog({
          defaultUri: root ? vscode.Uri.joinPath(root, params.defaultName) : undefined,
          filters: params.filters,
          saveLabel: 'Save'
        });
        if (!uri) {
          return undefined;
        }
        target = uri.fsPath;
      } else if (fs.existsSync(target)) {
        const ok = await vscode.window.showWarningMessage(`${path.basename(target)} already exists. Overwrite?`, { modal: true }, 'Overwrite');
        if (ok !== 'Overwrite') {
          return undefined;
        }
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, params.encoding === 'base64' ? Buffer.from(params.data, 'base64') : params.data);
      return target;
    },
    async openFile(params) {
      const uri = vscode.Uri.file(params.path);
      const column = params.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
      if (/\.(png|jpe?g|gif|svg|pdf)$/i.test(params.path)) {
        await vscode.commands.executeCommand('vscode.open', uri, column);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = params.line ?? 0;
      const pos = new vscode.Position(Math.min(line, Math.max(doc.lineCount - 1, 0)), 0);
      await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false, selection: new vscode.Range(pos, pos) });
    },
    async pickFiles(params) {
      const picked = await vscode.window.showOpenDialog({
        title: params.title,
        canSelectMany: params.canSelectMany ?? true,
        canSelectFolders: params.canSelectFolders ?? false,
        canSelectFiles: params.canSelectFiles ?? true,
        filters: params.filters,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
      });
      return (picked ?? []).map(u => u.fsPath);
    },
    async confirm(params) {
      const choice = await vscode.window.showWarningMessage(params.message, { modal: true, detail: params.detail }, params.action);
      return choice === params.action;
    },
    notify(params) {
      const show = params.level === 'error' ? vscode.window.showErrorMessage
        : params.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      void show(params.message);
    },
    runInTerminal(params) {
      const existing = params.name ? vscode.window.terminals.find(t => t.name === params.name) : undefined;
      const term = existing ?? vscode.window.createTerminal({ name: params.name ?? 'Orbital', cwd: params.cwd });
      term.show();
      term.sendText(params.command, params.execute ?? false);
    },
    activeEditorPath: () => lastEditorPath(),
    log
  };
}

let lastEditor: string | undefined;
/** The active text editor's file, or the last one when the studio panel itself has focus. */
function lastEditorPath(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file') {
    lastEditor = doc.uri.fsPath;
  }
  return lastEditor;
}

/** Track the last file editor so activeEditorPath() still knows it after focus moved to the studio. */
export function trackActiveEditor(context: vscode.ExtensionContext): void {
  lastEditorPath();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => lastEditorPath()));
}

export { log as studioLog };
