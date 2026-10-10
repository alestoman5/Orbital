// Webview side of the "geom" studio tab: two sub-tabs, Distributions
// (watched coordinates over XYZ trajectories / ensembles) and Trajectory
// (.dat) (MD column files with drift statistics). Each sub-tab is built
// lazily on first use and kept alive afterwards.

import './geom.css';
import type { GeomNavigateArgs } from '../../../../src/studio/tabs/geom/types';
import type { TabView } from '../../view';
import { subTabs } from '../../ui/components';
import { h, mount } from '../../ui/dom';
import { distributionsView, type SubView } from './distributions';
import { trajectoryView } from './trajectory';

type Sub = 'dist' | 'traj';

export const view: TabView = {
  mount(root, ctx) {
    let active: Sub = ctx.state<Sub>('sub', 'dist');
    const views: Partial<Record<Sub, SubView>> = {};
    const body = h('div.geom-body');
    const get = (s: Sub): SubView => (views[s] ??= s === 'dist' ? distributionsView(ctx) : trajectoryView(ctx));
    let strip: HTMLElement;

    const showSub = (s: Sub) => {
      active = s;
      ctx.setState('sub', s);
      const v = get(s);
      for (const [k, other] of Object.entries(views)) {
        if (other) other.el.hidden = k !== s;
      }
      if (v.el.parentElement !== body) body.append(v.el);
      v.show();
    };
    const renderStrip = () => {
      const next = subTabs<Sub>([{ value: 'dist', label: 'Distributions' }, { value: 'traj', label: 'Trajectory (.dat)' }], active, showSub);
      strip?.replaceWith(next);
      strip = next;
    };
    strip = h('nav');
    mount(root, strip, body);
    renderStrip();
    showSub(active);

    return {
      onNavigate(raw) {
        const args = (raw ?? {}) as GeomNavigateArgs;
        const target: Sub | undefined = typeof args.dat === 'string' ? 'traj' : args.xyz || args.mode || args.specs ? 'dist' : undefined;
        if (!target) return;
        showSub(target);
        renderStrip();
        get(target).navigate(args);
      },
      onShow() {
        views[active]?.show();
      },
      dispose() {
        Object.values(views).forEach(v => v?.dispose());
      }
    };
  }
};
