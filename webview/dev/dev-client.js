// Browser stand-in for the VS Code webview API: acquireVsCodeApi() posts
// requests to the dev server (/rpc) and host events arrive over SSE (/events).
// Also applies a VS Code-like theme (?theme=dark|light|hc) so the studio's
// --vscode-* variables resolve like in the real editor.
(function () {
  const params = new URLSearchParams(location.search);
  const THEMES = {
    dark: {
      cls: ['vscode-dark'],
      vars: {
        '--vscode-editor-background': '#1f1f1f', '--vscode-foreground': '#cccccc', '--vscode-editor-foreground': '#e6e6e6',
        '--vscode-descriptionForeground': '#9d9d9d', '--vscode-input-background': '#313131', '--vscode-input-foreground': '#cccccc',
        '--vscode-input-border': '#3c3c3c', '--vscode-focusBorder': '#0078d4', '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
        '--vscode-editor-font-family': 'Consolas, "Courier New", monospace', '--vscode-textCodeBlock-background': '#2b2b2b',
        '--vscode-scrollbarSlider-background': 'rgba(121,121,121,.4)', '--vscode-panel-border': '#2b2b2b',
        '--vscode-charts-blue': '#3794ff', '--vscode-charts-orange': '#d18616', '--vscode-charts-green': '#89d185',
        '--vscode-charts-red': '#f14c4c', '--vscode-charts-purple': '#b180d7', '--vscode-charts-yellow': '#cca700'
      }
    },
    light: {
      cls: ['vscode-light'],
      vars: {
        '--vscode-editor-background': '#ffffff', '--vscode-foreground': '#3b3b3b', '--vscode-editor-foreground': '#1f1f1f',
        '--vscode-descriptionForeground': '#717171', '--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#3b3b3b',
        '--vscode-input-border': '#cecece', '--vscode-focusBorder': '#005fb8', '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
        '--vscode-editor-font-family': 'Consolas, "Courier New", monospace', '--vscode-textCodeBlock-background': '#f2f2f2',
        '--vscode-scrollbarSlider-background': 'rgba(100,100,100,.4)', '--vscode-panel-border': '#e5e5e5',
        '--vscode-charts-blue': '#1a85ff', '--vscode-charts-orange': '#d18616', '--vscode-charts-green': '#388a34',
        '--vscode-charts-red': '#e51400', '--vscode-charts-purple': '#652d90', '--vscode-charts-yellow': '#bf8803'
      }
    },
    hc: {
      cls: ['vscode-high-contrast'],
      vars: {
        '--vscode-editor-background': '#000000', '--vscode-foreground': '#ffffff', '--vscode-editor-foreground': '#ffffff',
        '--vscode-descriptionForeground': '#ffffffb3', '--vscode-input-background': '#000000', '--vscode-input-foreground': '#ffffff',
        '--vscode-input-border': '#6fc3df', '--vscode-focusBorder': '#f38518', '--vscode-contrastBorder': '#6fc3df',
        '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif', '--vscode-editor-font-family': 'Consolas, monospace'
      }
    }
  };
  function applyTheme(name) {
    const t = THEMES[name] || THEMES.dark;
    document.body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast');
    document.body.classList.add(...t.cls);
    for (const [k, v] of Object.entries(t.vars)) {
      document.documentElement.style.setProperty(k, v);
    }
    window.__devTheme = name;
  }
  applyTheme(params.get('theme') || 'dark');
  window.__setTheme = applyTheme;

  const STATE_KEY = 'orbital-dev-state';
  window.acquireVsCodeApi = function () {
    return {
      postMessage(msg) {
        if (msg.kind === 'ready') {
          const args = params.get('args');
          const tab = params.get('tab');
          if (args && tab) {
            window.postMessage({ kind: 'event', channel: 'studio', name: 'navigate', payload: { tab, args: JSON.parse(args) } }, '*');
          }
          return;
        }
        fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
          .then(r => r.json())
          .then(res => window.postMessage(res, '*'))
          .catch(e => window.postMessage({ kind: 'response', id: msg.id, ok: false, error: String(e) }, '*'));
      },
      getState() {
        if (params.has('fresh')) {
          return undefined;
        }
        try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null') || undefined; } catch { return undefined; }
      },
      setState(s) {
        try { sessionStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
      }
    };
  };
  // Screenshots (?shot=1) skip the event stream: an open connection keeps headless browsers waiting forever.
  // Add &events=1 to keep host events when driving the page in real time (DevTools protocol).
  if (!params.has('shot') || params.has('events')) {
    const es = new EventSource('/events');
    es.onmessage = e => window.postMessage(JSON.parse(e.data), '*');
  }
})();
