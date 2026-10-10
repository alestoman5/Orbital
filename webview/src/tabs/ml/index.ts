// Webview side of the "ml" studio tab: "New run" (form generated from SPEC)
// and "Runs" (table, run detail with parity / learning curve / grid search,
// comparison). Host methods: src/studio/tabs/ml/host.ts.
//
// onNavigate args: { view?: 'new' | 'runs', run?: id, compare?: id[], duplicate?: id, form?: MlForm }

import './ml.css';
import { defaultForm, type MlForm } from '../../../../src/ml/spec';
import type { EnvCheck, MlInit } from '../../../../src/studio/tabs/ml/types';
import { button, busy, subTabs } from '../../ui/components';
import { h, mount } from '../../ui/dom';
import type { TabView } from '../../view';
import { renderForm } from './form';
import { createRunsView } from './runs';

type View = 'new' | 'runs';

interface NavArgs {
  view?: View;
  run?: string;
  compare?: string[];
  duplicate?: string;
  form?: MlForm;
}

export const view: TabView = {
  mount(root, ctx) {
    let current: View = ctx.state<View>('view', 'new');
    let form: MlForm = ctx.state<MlForm | null>('form', null) ?? defaultForm('precomputed', 'KRR');
    let init: MlInit | undefined;
    let env: EnvCheck | undefined;
    let shown = true;

    const tabsSlot = h('div.ml-subtabs');
    const formBox = h('div');
    const runsBox = h('div');
    mount(root, h('div.ml', null, tabsSlot, formBox, runsBox));

    const checkEnv = async (btn?: HTMLButtonElement, refresh = true) => {
      env = undefined;
      formView.refreshEnv();
      await busy(btn, async () => {
        env = await ctx.rpc<EnvCheck>('checkEnv', { refresh });
      });
      env ??= { ok: false, python: null, packages: {}, missing_required: [], error: 'the environment check failed' };
      formView.refreshEnv();
    };

    const runsView = createRunsView({
      ctx,
      duplicate: id => void busy(undefined, async () => {
        const f = await ctx.rpc<MlForm>('formOf', { id });
        setForm(f);
        show('new');
        ctx.toast('Configuration copied into the form', 'info');
      }),
      selectionChanged: (run, compare) => {
        ctx.setState('run', run);
        ctx.setState('compare', compare);
      }
    });
    runsView.restore(ctx.state<string | null>('run', null), ctx.state<string[]>('compare', []));
    runsBox.append(runsView.el);

    const formView = renderForm(formBox, {
      ctx,
      init: () => init,
      env: () => env,
      checkEnv: btn => checkEnv(btn),
      started: id => {
        show('runs');
        runsView.select(id);
      }
    }, form, f => {
      form = f;
      ctx.setState('form', f);
    });

    const setForm = (f: MlForm) => {
      form = f;
      ctx.setState('form', f);
      formView.setForm(f);
    };

    const envBtn = button('Check environment', e => void checkEnv(e.currentTarget as HTMLButtonElement), { icon: 'check', variant: 'ghost', title: 'Run python ml_worker.py --check' });
    const newBtn = button('New run', () => show('new'), { icon: 'plus', variant: 'ghost' });

    function show(v: View): void {
      current = v;
      ctx.setState('view', v);
      mount(tabsSlot, subTabs<View>([{ value: 'new', label: 'New run' }, { value: 'runs', label: 'Runs' }], v, show));
      formBox.hidden = v !== 'new';
      runsBox.hidden = v !== 'runs';
      ctx.setActions(v === 'new' ? envBtn : newBtn);
      if (v === 'runs' && shown) runsView.show();
      else runsView.hide();
    }

    void (async () => {
      try {
        init = await ctx.rpc<MlInit>('init');
      } catch (e) {
        ctx.toast(e instanceof Error ? e.message : String(e), 'error');
      }
      setForm(form);
      await checkEnv(undefined, false);   // once on first open (cached by the host)
    })();
    show(current);

    return {
      onNavigate(raw) {
        const a = (raw ?? {}) as NavArgs;
        if (a.form) setForm({ ...defaultForm(), ...a.form });
        if (a.duplicate) {
          void ctx.rpc<MlForm>('formOf', { id: a.duplicate }).then(f => { setForm(f); show('new'); }, e => ctx.toast(String(e), 'error'));
        }
        if (a.compare?.length) {
          show('runs');
          runsView.compare(a.compare);
        } else if (a.run) {
          show('runs');
          runsView.select(a.run);
        } else if (a.view) {
          show(a.view);
        }
      },
      onShow() {
        shown = true;
        if (current === 'runs') runsView.show();
      },
      onHide() {
        shown = false;
        runsView.hide();
      },
      dispose() {
        runsView.dispose();
      }
    };
  }
};
