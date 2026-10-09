import * as assert from 'assert';
import type { HostContext } from '../../src/studio/context';
import { TAB_HOSTS, dispatchStudioRequest, dispatchTabRequest } from '../../src/studio/registry';
import { TAB_IDS } from '../../src/studio/protocol';

function fakeContext(log: string[] = []): HostContext {
  return {
    tab: 'spectra',
    extensionPath: '.',
    workspaceFolders: () => ['/ws'],
    storageDir: () => undefined,
    config: (_k, fallback) => fallback,
    findFiles: async () => [],
    watch: () => ({ dispose() {} }),
    post: (name, payload) => log.push(`post ${name} ${JSON.stringify(payload)}`),
    navigate: tab => log.push(`navigate ${tab}`),
    saveFile: async p => `/ws/${p.defaultName}`,
    openFile: async () => undefined,
    pickFiles: async () => [],
    confirm: async () => true,
    notify: () => undefined,
    log: m => log.push(m)
  };
}

describe('studio registry', () => {
  it('has a host for every tab id', () => {
    assert.deepStrictEqual(Object.keys(TAB_HOSTS).sort(), [...TAB_IDS].sort());
    for (const id of TAB_IDS) {
      assert.strictEqual(TAB_HOSTS[id].id, id);
    }
  });

  it('reports unknown methods instead of throwing', async () => {
    const res = await dispatchTabRequest({ kind: 'request', id: 7, channel: 'spectra', method: 'nope' }, () => fakeContext());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.id, 7);
    assert.match(res.error ?? '', /unknown method spectra\.nope/);
  });

  it('turns a throwing method into an error response', async () => {
    const host = TAB_HOSTS.spectra;
    const saved = host.methods.__boom;
    host.methods.__boom = () => {
      throw new Error('bad input');
    };
    try {
      const log: string[] = [];
      const res = await dispatchTabRequest({ kind: 'request', id: 1, channel: 'spectra', method: '__boom' }, () => fakeContext(log));
      assert.deepStrictEqual([res.ok, res.error], [false, 'bad input']);
      assert.ok(log.some(l => l.includes('spectra.__boom failed')));
    } finally {
      if (saved) {
        host.methods.__boom = saved;
      } else {
        delete host.methods.__boom;
      }
    }
  });

  it('routes studio methods to the context', async () => {
    const log: string[] = [];
    const save = await dispatchStudioRequest(
      { kind: 'request', id: 2, channel: 'studio', method: 'saveFile', params: { defaultName: 'a.svg', data: '<svg/>' } },
      () => fakeContext(log),
      () => ({ workspaceFolders: [], colorTheme: 'dark', platform: 'test', extensionVersion: '0' })
    );
    assert.deepStrictEqual([save.ok, save.result], [true, '/ws/a.svg']);
    await dispatchStudioRequest(
      { kind: 'request', id: 3, channel: 'studio', method: 'sendToReport', params: { name: 'fig' } },
      () => fakeContext(log),
      () => ({ workspaceFolders: [], colorTheme: 'dark', platform: 'test', extensionVersion: '0' })
    );
    assert.deepStrictEqual(log, ['navigate report', 'post incomingFigure {"name":"fig"}']);
  });
});
