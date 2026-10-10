// Webview end of the studio protocol (src/studio/protocol.ts): request /
// response RPC to the extension host, and host-pushed events.

import type { Channel, EventMessage, ToHost, ToWebview } from '../../src/studio/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi: VsCodeApi = acquireVsCodeApi();

let nextId = 1;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') {
    return;
  }
  if (m.kind === 'response') {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error ?? 'request failed'));
    }
  } else if (m.kind === 'event') {
    emit(m);
  }
});

function emit(m: EventMessage): void {
  listeners.get(`${m.channel}:${m.name}`)?.forEach(cb => {
    try {
      cb(m.payload);
    } catch (err) {
      console.error(err);
    }
  });
}

export function request<T>(channel: Channel, method: string, params?: unknown): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscodeApi.postMessage({ kind: 'request', id, channel, method, params } satisfies ToHost);
  });
}

/** Subscribe to a host event; returns the unsubscribe function. */
export function onEvent(channel: Channel, name: string, cb: (payload: unknown) => void): () => void {
  const key = `${channel}:${name}`;
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => set!.delete(cb);
}

export function signalReady(): void {
  vscodeApi.postMessage({ kind: 'ready' } satisfies ToHost);
}

// Persisted per-panel state (survives the panel being hidden and VS Code reloads).
type Store = Record<string, unknown>;
const store: Store = (vscodeApi.getState() as Store) ?? {};

export function getState<T>(key: string, fallback: T): T {
  return key in store ? (store[key] as T) : fallback;
}

export function setState(key: string, value: unknown): void {
  store[key] = value;
  vscodeApi.setState(store);
}
