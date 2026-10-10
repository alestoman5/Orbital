// Small modal dialog for the Report tab (conflict on save, Send to report).
// Lives inside the tab root; Escape or the backdrop cancels.

import { icon } from '../../ui/components';
import { Child, h } from '../../ui/dom';

export interface DialogAction<T> {
  label: string;
  value: T;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Return false to keep the dialog open (e.g. validation failed). */
  before?: () => boolean | Promise<boolean>;
}

export function dialog<T>(host: HTMLElement, o: { title: string; body: Child; actions: DialogAction<T>[]; cancel: T; wide?: boolean }): Promise<T> {
  return new Promise<T>(resolve => {
    const close = (v: T) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(o.cancel);
      }
    };
    const buttons = o.actions.map(a => h('button.btn', {
      type: 'button', class: a.variant ?? 'secondary',
      onclick: async () => {
        if (a.before && !(await a.before())) return;
        close(a.value);
      }
    }, a.label));
    const box = h('div.rp-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title, class: o.wide ? 'wide' : '' },
      h('div.rp-dialog-head', null, h('h2', null, o.title),
        h('button.icon-btn', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => close(o.cancel) }, icon('close'))),
      h('div.rp-dialog-body', null, o.body),
      h('div.rp-dialog-actions', null, buttons));
    const overlay = h('div.rp-overlay', { onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(o.cancel); } }, box);
    host.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => (box.querySelector('input, textarea, select, button.primary') as HTMLElement | null)?.focus());
  });
}
