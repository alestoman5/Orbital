// Host side of the "inputs" studio tab. Placeholder from the studio scaffold;
// owned by the agent that builds this tab. Must not import 'vscode' — use
// the HostContext passed to every method (see ../../context.ts).

import type { TabHost } from '../../context';

export const host: TabHost = {
  id: 'inputs',
  methods: {}
};
