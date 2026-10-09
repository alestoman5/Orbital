// All tab hosts, plus the request dispatcher shared by the VS Code panel and
// the dev harness. Adding a tab = a host.ts under tabs/ and a line here.

import type { HostContext, TabHost } from './context';
import type { RequestMessage, ResponseMessage, StudioInfo, TabId } from './protocol';
import { host as spectra } from './tabs/spectra/host';
import { host as calcs } from './tabs/calcs/host';
import { host as runs } from './tabs/runs/host';
import { host as geom } from './tabs/geom/host';
import { host as inputs } from './tabs/inputs/host';
import { host as ml } from './tabs/ml/host';
import { host as report } from './tabs/report/host';

export const TAB_HOSTS: Record<TabId, TabHost> = { spectra, calcs, runs, geom, inputs, ml, report };

/**
 * Runs one tab request. Errors become `{ ok: false, error }` so the webview
 * can show them instead of hanging on a promise that never settles.
 */
export async function dispatchTabRequest(
  msg: RequestMessage,
  contextFor: (tab: TabId) => HostContext
): Promise<ResponseMessage> {
  const tab = TAB_HOSTS[msg.channel as TabId];
  const method = tab?.methods[msg.method];
  if (!method) {
    return { kind: 'response', id: msg.id, ok: false, error: `unknown method ${msg.channel}.${msg.method}` };
  }
  try {
    const result = await method(msg.params, contextFor(tab.id));
    return { kind: 'response', id: msg.id, ok: true, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    contextFor(tab.id).log(`${msg.channel}.${msg.method} failed: ${e instanceof Error && e.stack ? e.stack : error}`);
    return { kind: 'response', id: msg.id, ok: false, error };
  }
}

/**
 * Methods of the 'studio' channel (see StudioMethods in protocol.ts). They map
 * onto the HostContext, so the panel and the dev harness share this code.
 */
export async function dispatchStudioRequest(
  msg: RequestMessage,
  contextFor: (tab: TabId) => HostContext,
  info: () => StudioInfo
): Promise<ResponseMessage> {
  const ctx = contextFor('report');
  const p = msg.params as any;
  const ok = (result?: unknown): ResponseMessage => ({ kind: 'response', id: msg.id, ok: true, result });
  try {
    switch (msg.method) {
      case 'info': return ok(info());
      case 'saveFile': return ok(await ctx.saveFile(p));
      case 'openFile': return ok(await ctx.openFile(p));
      case 'pickFiles': return ok(await ctx.pickFiles(p ?? {}));
      case 'confirm': return ok(await ctx.confirm(p));
      case 'notify': ctx.notify(p); return ok();
      case 'getConfig': return ok(ctx.config(String(p?.key ?? ''), undefined));
      case 'sendToReport':
        ctx.navigate('report');
        ctx.post('incomingFigure', p);
        return ok();
      default:
        return { kind: 'response', id: msg.id, ok: false, error: `unknown method studio.${msg.method}` };
    }
  } catch (e) {
    return { kind: 'response', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
