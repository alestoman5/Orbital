// The Orbital Studio webview panel: one instance per window, tabs inside.
// Routes webview requests to the tab hosts (registry.ts) and keeps the
// activation disposables of the tabs for the lifetime of the panel.

import * as vscode from 'vscode';
import type { HostContext } from './context';
import type { EventMessage, NavigatePayload, StudioInfo, TabId, ToHost, ToWebview } from './protocol';
import { TAB_HOSTS, dispatchStudioRequest, dispatchTabRequest } from './registry';
import { allowUserPaths, pathsInArgs } from './paths';
import { createVscodeContext, studioLog, trackActiveEditor } from './vscodeContext';

export class StudioPanel {
  private static current: StudioPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly contexts = new Map<TabId, HostContext>();
  private ready = false;
  private disposed = false;
  private readonly queue: ToWebview[] = [];

  /** Opens (or reveals) the studio, optionally on a tab with arguments. */
  static show(extensionUri: vscode.Uri, nav?: NavigatePayload): StudioPanel {
    if (StudioPanel.current) {
      StudioPanel.current.panel.reveal(StudioPanel.current.panel.viewColumn ?? vscode.ViewColumn.Active);
    } else {
      StudioPanel.current = new StudioPanel(extensionUri);
    }
    if (nav) {
      // Command arguments come from a menu or the explorer: the user chose these paths.
      allowUserPaths(pathsInArgs(nav.args));
      StudioPanel.current.navigate(nav.tab, nav.args);
    }
    return StudioPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel('orbitalStudio', 'Orbital Studio', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'webview'), vscode.Uri.joinPath(extensionUri, 'media')]
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'orca-icon.svg');
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: ToHost) => void this.onMessage(m)),
      vscode.window.onDidChangeActiveColorTheme(() => this.send({ kind: 'event', channel: 'studio', name: 'theme', payload: this.info().colorTheme }))
    );
    for (const host of Object.values(TAB_HOSTS)) {
      try {
        const d = host.activate?.(this.contextFor(host.id));
        if (d) {
          this.disposables.push(d);
        }
      } catch (e) {
        studioLog(`activate ${host.id} failed: ${e instanceof Error ? e.stack : String(e)}`);
      }
    }
  }

  navigate(tab: TabId, args?: unknown): void {
    this.send({ kind: 'event', channel: 'studio', name: 'navigate', payload: { tab, args } satisfies NavigatePayload });
  }

  private contextFor(tab: TabId): HostContext {
    let ctx = this.contexts.get(tab);
    if (!ctx) {
      ctx = createVscodeContext(tab, this.extensionUri.fsPath, {
        post: (channel, name, payload) => this.send({ kind: 'event', channel, name, payload } satisfies EventMessage),
        navigate: (t, args) => this.navigate(t, args)
      });
      this.contexts.set(tab, ctx);
    }
    return ctx;
  }

  private info(): StudioInfo {
    const kind = vscode.window.activeColorTheme.kind;
    return {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      colorTheme: kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light'
        : kind === vscode.ColorThemeKind.HighContrast ? 'high-contrast' : 'dark',
      platform: process.platform,
      extensionVersion: String(vscode.extensions.getExtension('alestoman5.orca-inp')?.packageJSON.version ?? '')
    };
  }

  private async onMessage(m: ToHost): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (m.kind === 'ready') {
      this.ready = true;
      this.queue.splice(0).forEach(q => void this.panel.webview.postMessage(q));
      return;
    }
    if (m.kind !== 'request') {
      return;
    }
    const res = m.channel === 'studio'
      ? await dispatchStudioRequest(m, t => this.contextFor(t), () => this.info())
      : await dispatchTabRequest(m, t => this.contextFor(t));
    this.send(res);
  }

  /** Events wait until the webview said 'ready' (navigate right after creation would be lost). */
  private send(msg: ToWebview): void {
    if (this.disposed) {
      return;   // a long request finished after the panel was closed
    }
    if (this.ready) {
      void this.panel.webview.postMessage(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...p)).toString();
    const nonce = Array.from({ length: 32 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} data: blob:`
    ].join('; ');
    const assetBase = asset('out', 'webview') + '/';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('out', 'webview', 'studio.css')}">
<title>Orbital Studio</title>
</head>
<body>
<div id="app" data-asset-base="${assetBase}" data-media-base="${asset('media')}/"></div>
<script nonce="${nonce}" src="${asset('out', 'webview', 'studio.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    StudioPanel.current = undefined;
    this.disposables.splice(0).forEach(d => d.dispose());
    this.panel.dispose();
  }
}

export function registerStudio(context: vscode.ExtensionContext): void {
  trackActiveEditor(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('orcaInp.openStudio', (tab?: TabId, args?: unknown) =>
      StudioPanel.show(context.extensionUri, typeof tab === 'string' ? { tab, args } : undefined)
    )
  );
}

/** For commands elsewhere in the extension: open the studio on a tab. */
export function openStudio(extensionUri: vscode.Uri, tab: TabId, args?: unknown): void {
  StudioPanel.show(extensionUri, { tab, args });
}
