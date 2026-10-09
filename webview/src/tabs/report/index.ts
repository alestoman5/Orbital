// Webview side of the "report" studio tab. Placeholder from the studio scaffold;
// owned by the agent that builds this tab (see webview/src/view.ts for the
// contract, webview/src/ui for components, webview/src/charts for plots).

import type { TabView } from '../../view';
import { emptyState } from '../../ui/components';

export const view: TabView = {
  mount(root) {
    root.append(emptyState('report', 'Coming soon', 'This tab is being built.'));
  }
};
