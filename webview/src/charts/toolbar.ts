// Figure toolbar for a chart card: Screen / Publication switch, journal size
// (or custom width × height in mm / in), Export menu and "Send to report".

import { icon, segmented, select } from '../ui/components';
import { h } from '../ui/dom';
import { JOURNAL_SIZES, type FigureSize, type FigureToolbarOptions, type Preset } from './api';
import { buildCsv } from './csv';
import { pdfBytes, pngBlob } from './export';
import { toBase64 } from './fonts';
import { svgString } from './svgExport';
import { screenTheme } from './themes';

const CUSTOM = 'custom';

function sizeKey(size: FigureSize | undefined): string {
  if (!size) {
    return 'acs-1col';
  }
  const hit = Object.entries(JOURNAL_SIZES).find(([, s]) => Math.abs(s.widthIn - size.widthIn) < 1e-3 && Math.abs(s.heightIn - size.heightIn) < 1e-3);
  return hit ? hit[0] : CUSTOM;
}

function utf8Base64(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

let menuCounter = 0;

export function buildToolbar(o: FigureToolbarOptions): HTMLElement {
  let preset: Preset = o.initialPreset ?? 'screen';
  let size: FigureSize = o.initialSize ?? o.figure().size ?? JOURNAL_SIZES['acs-1col'];
  let unit: 'mm' | 'in' = 'mm';
  const host = o.host;
  const changed = () => o.onLayoutChange?.(preset, size);

  // --- size ---------------------------------------------------------------------------
  const factor = () => (unit === 'mm' ? 25.4 : 1);
  const fmtLen = (inches: number) => String(Math.round(inches * factor() * (unit === 'mm' ? 1 : 100)) / (unit === 'mm' ? 1 : 100));
  const wIn = h('input.input.num', { type: 'number', min: '10', step: 'any', title: 'Width', 'aria-label': 'Width' });
  const hIn = h('input.input.num', { type: 'number', min: '10', step: 'any', title: 'Height', 'aria-label': 'Height' });
  const syncCustom = () => {
    wIn.value = fmtLen(size.widthIn);
    hIn.value = fmtLen(size.heightIn);
  };
  const readCustom = () => {
    const w = parseFloat(wIn.value) / factor();
    const ht = parseFloat(hIn.value) / factor();
    if (w > 0.5 && ht > 0.5 && w < 40 && ht < 40) {
      size = { widthIn: w, heightIn: ht };
      changed();
    }
  };
  wIn.addEventListener('change', readCustom);
  hIn.addEventListener('change', readCustom);
  const unitSel = select<'mm' | 'in'>([{ value: 'mm', label: 'mm' }, { value: 'in', label: 'in' }], unit, v => {
    unit = v;
    syncCustom();
  });
  unitSel.classList.add('figure-toolbar-unit');
  const custom = h('div.figure-toolbar-custom', null, wIn, h('span.muted', null, '×'), hIn, unitSel);
  const sizeOptions = [
    ...Object.entries(JOURNAL_SIZES).map(([k, s]) => ({ value: k, label: s.label })),
    { value: CUSTOM, label: 'Custom…' }
  ];
  const sizeSel = select(sizeOptions, sizeKey(size), v => {
    if (v === CUSTOM) {
      custom.hidden = false;
      syncCustom();
      wIn.focus();
      return;
    }
    custom.hidden = true;
    const s = JOURNAL_SIZES[v];
    size = { widthIn: s.widthIn, heightIn: s.heightIn };
    changed();
  });
  sizeSel.classList.add('figure-toolbar-size');
  sizeSel.title = 'Figure size (publication preview and exports)';
  custom.hidden = sizeKey(size) !== CUSTOM;
  syncCustom();

  // --- preset ----------------------------------------------------------------------------
  const presetSwitch = segmented<Preset>([{ value: 'screen', label: 'Screen' }, { value: 'publication', label: 'Publication' }], preset, v => {
    preset = v;
    changed();
  });

  // --- export ------------------------------------------------------------------------------
  const exportOpts = () => ({ size, preset: 'publication' as Preset });
  const save = async (ext: string, data: string, encoding: 'utf8' | 'base64', filterName: string) => {
    const path = await host.studio('saveFile', { defaultName: `${o.name}.${ext}`, data, encoding, filters: { [filterName]: [ext] } });
    if (path) {
      host.toast(`Saved ${path.split(/[\\/]/).pop()}`, 'success');
    }
  };
  const actions: { label: string; hint?: string; run: () => Promise<void>; sep?: boolean }[] = [
    { label: 'SVG', hint: 'vector, editable text', run: async () => save('svg', svgString(o.figure(), exportOpts(), () => screenTheme(document.body, o.figure())), 'utf8', 'SVG image') },
    { label: 'PDF', hint: 'vector, embedded Arimo', run: async () => save('pdf', toBase64(await pdfBytes(o.figure(), exportOpts())), 'base64', 'PDF document') },
    { label: 'PNG', hint: '300 dpi', run: async () => save('png', toBase64(new Uint8Array(await (await pngBlob(o.figure(), { ...exportOpts(), dpi: 300 })).arrayBuffer())), 'base64', 'PNG image') },
    { label: 'PNG', hint: '600 dpi', run: async () => save('png', toBase64(new Uint8Array(await (await pngBlob(o.figure(), { ...exportOpts(), dpi: 600 })).arrayBuffer())), 'base64', 'PNG image') },
    { label: 'CSV', hint: 'plotted data', run: async () => save('csv', buildCsv(o.figure()), 'utf8', 'CSV table') },
    {
      label: 'Copy PNG', hint: '300 dpi', sep: true, run: async () => {
        try {
          const blob = await pngBlob(o.figure(), { ...exportOpts(), dpi: 300 });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          host.toast('Figure copied to the clipboard', 'success');
        } catch (e) {
          host.toast(`Could not copy the figure: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      }
    }
  ];
  const menuId = `chart-menu-${++menuCounter}`;
  const exportBtn = h('button.btn.secondary.figure-toolbar-export', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, title: 'Export the figure' },
    icon('download'), 'Export', icon('chevronDown', 'icon chevron'));
  const menu = h('div.chart-menu', { id: menuId, role: 'menu', hidden: true });
  const run = async (btn: HTMLButtonElement, work: () => Promise<void>) => {
    btn.classList.add('busy');
    btn.disabled = true;
    try {
      await work();
    } catch (e) {
      host.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      btn.classList.remove('busy');
      btn.disabled = false;
    }
  };
  for (const a of actions) {
    if (a.sep) {
      menu.appendChild(h('div.chart-menu-sep', { role: 'separator' }));
    }
    menu.appendChild(h('button.chart-menu-item', {
      type: 'button', role: 'menuitem',
      onclick: () => {
        closeMenu();
        void run(exportBtn, a.run);
      }
    }, h('span', null, a.label), a.hint ? h('span.chart-menu-hint', null, a.hint) : null));
  }
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('.chart-menu-item')];
  const onDoc = (e: Event) => {
    if (!wrap.contains(e.target as Node)) {
      closeMenu();
    }
  };
  const openMenu = () => {
    menu.hidden = false;
    exportBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    items()[0]?.focus();
  };
  const closeMenu = () => {
    menu.hidden = true;
    exportBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
  };
  exportBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      closeMenu();
      exportBtn.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    }
  });
  const wrap = h('div.chart-menu-wrap', null, exportBtn, menu);

  // --- send to report ------------------------------------------------------------------------
  const sendBtn = o.sendToReport === false ? null : h('button.btn.primary.figure-toolbar-send', { type: 'button', title: 'Add this figure (PDF + PNG) to the report' }, icon('send'), 'Send to report');
  sendBtn?.addEventListener('click', () => void run(sendBtn, async () => {
    const fig = o.figure();
    const [pdf, png] = await Promise.all([pdfBytes(fig, exportOpts()), pngBlob(fig, { ...exportOpts(), dpi: 300 })]);
    await host.studio('sendToReport', { name: o.name, caption: o.caption?.(), pdf: toBase64(pdf), png: toBase64(new Uint8Array(await png.arrayBuffer())) });
    host.toast('Figure sent to the report', 'success');
  }));

  return h('div.figure-toolbar', { role: 'toolbar', 'aria-label': 'Figure' },
    presetSwitch,
    h('div.figure-toolbar-sizes', null, sizeSel, custom),
    h('span.figure-toolbar-spacer'),
    wrap,
    sendBtn);
}
