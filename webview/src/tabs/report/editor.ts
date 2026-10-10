// Document view of the Report tab: the TexDoc model (src/report/texDoc.ts)
// rendered as a paper-like page. Sections with editable titles, bullet lists
// edited as rich text, figure cards (thumbnail, path, width, caption, label)
// and raw LaTeX blocks as auto-sized monospace text areas. Edits mutate the
// model in place; only touched fields change, so untouched blocks serialize
// byte for byte as they were read.

import { figureBlock, serializeBlock, type FigureBlock, type ItemsBlock, type RawBlock, type TexBlock, type TexDoc, type TexSection } from '../../../../src/report/texDoc';
import type { ThumbResponse } from '../../../../src/studio/tabs/report/types';
import { icon } from '../../ui/components';
import { h, mount } from '../../ui/dom';
import type { IconName } from '../../ui/icons';
import { pdfThumb } from './pdf';
import { htmlToTex, prettyTex, richEditable, texToHtml } from './richtext';

export interface EditorHost {
  dirty(): void;
  /** The section the cursor is in (target of Insert / Send to report). */
  focusSection(i: number): void;
  thumb(ref: string): Promise<ThumbResponse>;
  assetBase: string;
  /** \includegraphics names of the figures folder (path suggestions). */
  figureRefs(): string[];
  confirm(message: string, action: string): Promise<boolean>;
}

type Thumb = { src: string; kind: 'image' | 'pdf' } | { missing: string };

const ctl = (name: IconName, title: string, onClick: () => void, danger = false) =>
  h('button.rp-ctl', { type: 'button', title, 'aria-label': title, class: [danger ? 'danger' : '', /up$/i.test(title) ? 'up' : ''].join(' '), onmousedown: (e: Event) => e.preventDefault(), onclick: onClick }, icon(name));

/** Textarea that grows with its content. */
export function autoArea(value: string, onInput: (v: string) => void, cls = ''): HTMLTextAreaElement {
  const ta = h('textarea.rp-tex', { class: cls, value, spellcheck: 'false', rows: 1 });
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener('input', () => {
    onInput(ta.value);
    fit();
  });
  requestAnimationFrame(fit);
  new ResizeObserver(() => { if (ta.isConnected && ta.offsetWidth) fit(); }).observe(ta);
  return ta;
}

function blockKind(b: RawBlock): string {
  const t = b.tex.trimStart();
  const env = /^\\begin\{([^}]+)\}/.exec(t);
  if (env) return env[1];
  const cmd = /^\\(sub)*section\*?|^\\paragraph|^\\(noindent|vspace|clearpage|newpage|input|include)\b/.exec(t);
  if (cmd) return cmd[0].slice(1);
  if (!t) return 'empty';
  return 'text';
}

function swap<T>(arr: T[], i: number, j: number): boolean {
  if (j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

/** Move a block keeping the leads positional (blank lines stay where they were). */
function moveBlock(blocks: TexBlock[], i: number, d: number): boolean {
  const j = i + d;
  if (j < 0 || j >= blocks.length) return false;
  const li = blocks[i].lead, lj = blocks[j].lead;
  swap(blocks, i, j);
  blocks[i].lead = li;
  blocks[j].lead = lj;
  return true;
}

export function createEditor(host: EditorHost) {
  const el = h('div.rp-paper');
  let doc: TexDoc | null = null;
  const thumbs = new Map<string, Promise<Thumb>>();

  const changed = () => host.dirty();

  const thumbOf = (ref: string): Promise<Thumb> => {
    let p = thumbs.get(ref);
    if (!p) {
      p = host.thumb(ref).then(async (t): Promise<Thumb> => {
        if (t.kind === 'image') return { src: t.dataUrl, kind: 'image' };
        if (t.kind === 'pdf') {
          try {
            const c = await pdfThumb(host.assetBase, t.data, 360);
            return { src: c.toDataURL('image/png'), kind: 'pdf' };
          } catch (e) {
            return { missing: `PDF could not be rendered (${e instanceof Error ? e.message : e})` };
          }
        }
        if (t.kind === 'too-large') return { missing: `too large to preview (${Math.round(t.size / 1e6)} MB)` };
        return { missing: 'file not found' };
      }, (e): Thumb => ({ missing: e instanceof Error ? e.message : String(e) }));
      thumbs.set(ref, p);
    }
    return p;
  };

  // --- blocks ------------------------------------------------------------------

  function itemsView(b: ItemsBlock, si: number, bi: number): HTMLElement {
    const list = h(b.env === 'enumerate' ? 'ol' : 'ul', { class: 'rp-items' });
    const renderItems = (focus?: number) => {
      mount(list, b.items.map((it, k) => {
        let field: HTMLElement;
        if (richEditable(it.text)) {
          field = h('div.rp-rich', { contenteditable: 'true', spellcheck: 'true', innerHTML: texToHtml(it.text) });
          field.addEventListener('input', () => { it.text = htmlToTex(field); changed(); });
          field.addEventListener('paste', e => {
            e.preventDefault();
            document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') ?? '').replace(/\s+/g, ' '));
          });
          field.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              b.items.splice(k + 1, 0, { text: '' });
              changed();
              renderItems(k + 1);
            } else if (e.key === 'Backspace' && !field.textContent && b.items.length > 1) {
              e.preventDefault();
              b.items.splice(k, 1);
              changed();
              renderItems(Math.max(0, k - 1));
            }
          });
        } else {
          field = autoArea(it.text, v => { it.text = v; changed(); }, 'rp-item-tex');
          field.title = 'This item contains LaTeX structure (nested list, comment or line break): edit it as LaTeX';
        }
        return h('li.rp-item', null, field,
          h('span.rp-item-ctl', null,
            ctl('chevronDown', 'Move up', () => { if (swap(b.items, k, k - 1)) { changed(); renderItems(k - 1); } }),
            ctl('chevronDown', 'Move down', () => { if (swap(b.items, k, k + 1)) { changed(); renderItems(k + 1); } }),
            ctl('close', 'Remove item', () => {
              b.items.splice(k, 1);
              changed();
              if (!b.items.length) removeBlock(si, bi);
              else renderItems();
            }, true)));
      }));
      if (focus !== undefined) {
        const f = list.children[focus]?.querySelector<HTMLElement>('.rp-rich, textarea');
        f?.focus();
      }
    };
    renderItems();
    return h('div.rp-items-wrap', null, list,
      h('button.rp-add-item', { type: 'button', onclick: () => { b.items.push({ text: '' }); changed(); renderItems(b.items.length - 1); } }, icon('plus'), 'item'));
  }

  function figureView(b: FigureBlock): HTMLElement {
    const thumbBox = h('div.rp-fig-thumb', null, h('div.rp-fig-loading'));
    const showThumb = () => {
      if (!b.path) {
        mount(thumbBox, h('div.rp-fig-missing', null, icon('file'), 'no \\includegraphics'));
        return;
      }
      const ref = b.path;
      void thumbOf(ref).then(t => {
        if (b.path !== ref) return;
        mount(thumbBox, 'src' in t
          ? [h('img', { src: t.src, alt: ref, loading: 'lazy' }), t.kind === 'pdf' ? h('span.rp-fig-badge', null, 'PDF') : null]
          : h('div.rp-fig-missing', null, icon('warning'), h('span', null, ref), h('span.muted', null, t.missing)));
      });
    };
    showThumb();
    const listId = `rp-figs-${Math.random().toString(36).slice(2)}`;
    const pathInput = h('input.rp-fig-input.mono', {
      value: b.path ?? '', list: listId, spellcheck: 'false', placeholder: 'figures/name.pdf',
      onchange: (e: Event) => { b.path = (e.target as HTMLInputElement).value.trim() || null; changed(); showThumb(); }
    });
    const widthInput = h('input.rp-fig-input.mono', {
      value: b.width ?? '', spellcheck: 'false', placeholder: 'natural size',
      oninput: (e: Event) => { b.width = (e.target as HTMLInputElement).value.trim() || null; changed(); }
    });
    const labelInput = h('input.rp-fig-input.mono', {
      value: b.label ?? '', spellcheck: 'false', placeholder: 'fig:…',
      oninput: (e: Event) => { b.label = (e.target as HTMLInputElement).value.trim() || null; changed(); }
    });
    const caption = autoArea(b.caption ?? '', v => { b.caption = v; changed(); }, 'rp-caption');
    caption.placeholder = b.caption === null ? 'no \\caption (type to add one)' : 'caption (LaTeX)';
    const multi = (b.raw.match(/\\includegraphics/g) ?? []).length > 1;
    return h('figure.rp-figure', null,
      thumbBox,
      h('figcaption.rp-fig-meta', null,
        h('div.rp-fig-row', null,
          h('label', null, h('span', null, 'File'), pathInput),
          h('label.narrow', null, h('span', null, 'Width'), widthInput),
          h('label.narrow', null, h('span', null, 'Label'), labelInput)),
        h('datalist', { id: listId }, host.figureRefs().map(r => h('option', { value: r }))),
        h('div.rp-fig-caption', null, h('span.rp-fig-capno', null, 'Figure.'), caption),
        multi ? h('p.rp-hint', null, 'This figure has several images; the fields edit the first one. Edit the others as LaTeX (</> button).') : null));
  }

  function rawView(b: RawBlock): HTMLElement {
    return h('div.rp-raw', null,
      h('span.rp-kind', null, blockKind(b)),
      autoArea(b.tex, v => { b.tex = v; changed(); }));
  }

  function blockView(s: TexSection, si: number, b: TexBlock, bi: number): HTMLElement {
    const body = b.type === 'items' ? itemsView(b, si, bi) : b.type === 'figure' ? figureView(b) : rawView(b);
    const ctls = h('div.rp-block-ctl', null,
      b.type === 'figure' ? ctl('inputs', 'Edit as LaTeX', () => {
        const raw: RawBlock = { type: 'raw', tex: serializeBlock(b), lead: b.lead };
        s.blocks[bi] = raw;
        changed();
        render();
      }) : null,
      ctl('chevronDown', 'Move up', () => { if (moveBlock(s.blocks, bi, -1)) { changed(); render(); } }),
      ctl('chevronDown', 'Move down', () => { if (moveBlock(s.blocks, bi, 1)) { changed(); render(); } }),
      ctl('trash', 'Delete block', () => void (async () => {
        if (await host.confirm(`Delete this ${b.type === 'raw' ? blockKind(b) : b.type} block?`, 'Delete')) removeBlock(si, bi);
      })(), true));
    return h('div.rp-block', { dataset: { kind: b.type, block: `${si}.${bi}` } }, body, ctls);
  }

  function removeBlock(si: number, bi: number): void {
    const s = doc!.sections[si];
    const [gone] = s.blocks.splice(bi, 1);
    if (bi === 0 && s.blocks.length && gone.lead !== undefined) s.blocks[0].lead = gone.lead;
    changed();
    render();
  }

  // --- sections --------------------------------------------------------------------

  function addMenu(s: TexSection, si: number): HTMLElement {
    const add = (b: TexBlock) => {
      s.blocks.push(b);
      changed();
      render(`${si}.${s.blocks.length - 1}`);
    };
    return h('div.rp-add', null,
      h('span.rp-add-label', null, icon('plus'), 'Add'),
      h('button', { type: 'button', onclick: () => add({ type: 'items', env: 'itemize', head: '\\begin{itemize}', items: [{ prefix: '  \\item ', text: '' }], tail: '\\end{itemize}' }) }, 'Bullets'),
      h('button', { type: 'button', onclick: () => add({ type: 'raw', tex: '' }) }, 'Text'),
      h('button', { type: 'button', onclick: () => add(figureBlock(host.figureRefs()[0] ?? 'figures/name.pdf', '', '', '0.85\\textwidth')) }, 'Figure'),
      h('button', { type: 'button', onclick: () => add({ type: 'raw', tex: '\\begin{table}[htbp]\n\\centering\n\\begin{tabular}{ll}\n\\toprule\nA & B \\\\\n\\midrule\n & \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{}\n\\end{table}' }) }, 'Table'));
  }

  function sectionView(s: TexSection, si: number): HTMLElement {
    const sec = h('section.rp-section', { dataset: { section: String(si) } });
    sec.addEventListener('focusin', () => host.focusSection(si));
    if (s.heading !== false) {
      // shown typeset (thin spaces, inline math); focusing it switches to the LaTeX source
      const title = h('h2.rp-title', { contenteditable: 'plaintext-only', spellcheck: 'true', title: 'Section title (LaTeX)', innerHTML: prettyTex(s.title) });
      title.addEventListener('focus', () => { title.textContent = s.title; });
      title.addEventListener('blur', () => { title.innerHTML = prettyTex(s.title); });
      title.addEventListener('input', () => { s.title = title.textContent ?? ''; changed(); });
      title.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
      sec.append(h('div.rp-sec-head', null,
        h('span.rp-sec-num', null, s.starred ? '§' : `${doc!.sections.slice(0, si + 1).filter(x => x.heading !== false && !x.starred).length}`),
        title,
        h('div.rp-sec-ctl', null,
          h('label.rp-check', { title: 'Start the section on a new page (\\clearpage)' },
            h('input', { type: 'checkbox', checked: s.clearpage, onchange: (e: Event) => { s.clearpage = (e.target as HTMLInputElement).checked; changed(); } }), 'new page'),
          h('label.rp-check', { title: '\\section* (unnumbered)' },
            h('input', { type: 'checkbox', checked: s.starred, onchange: (e: Event) => { s.starred = (e.target as HTMLInputElement).checked; changed(); render(); } }), 'unnumbered'),
          ctl('chevronDown', 'Move section up', () => { if (moveSection(si, -1)) { changed(); render(); } }),
          ctl('chevronDown', 'Move section down', () => { if (moveSection(si, 1)) { changed(); render(); } }),
          ctl('trash', 'Delete section', () => void (async () => {
            if (await host.confirm(`Delete section "${s.title}" with its ${s.blocks.length} blocks?`, 'Delete')) {
              doc!.sections.splice(si, 1);
              changed();
              render();
            }
          })(), true))));
    }
    s.blocks.forEach((b, bi) => sec.append(blockView(s, si, b, bi)));
    sec.append(addMenu(s, si));
    return sec;
  }

  function moveSection(si: number, d: number): boolean {
    const secs = doc!.sections;
    const j = si + d;
    if (j < 0 || j >= secs.length || secs[si].heading === false || secs[j].heading === false) return false;
    // trailing text belongs to the position (e.g. what precedes \end{document})
    const ti = secs[si].trailing, tj = secs[j].trailing;
    swap(secs, si, j);
    secs[si].trailing = ti;
    secs[j].trailing = tj;
    return true;
  }

  // --- document ----------------------------------------------------------------------

  function render(focus?: string): void {
    if (!doc) {
      mount(el);
      return;
    }
    const d = doc;
    const pre = autoArea(d.preamble, v => { d.preamble = v; changed(); }, 'rp-preamble');
    const titleMatch = /\\title\{([^}]*)\}/.exec(d.preamble);
    mount(el,
      h('details.rp-pre', null, h('summary', null, icon('chevronRight', 'icon chevron'), 'Preamble', titleMatch ? h('span.muted', null, ` · ${titleMatch[1]}`) : null), pre),
      d.sections.map((s, si) => sectionView(s, si)),
      h('button.rp-add-section', {
        type: 'button', onclick: () => {
          const last = d.sections[d.sections.length - 1];
          d.sections.push({ heading: true, clearpage: false, starred: last?.starred ?? false, title: 'New section', blocks: [], trailing: '\n' });
          changed();
          render(`${d.sections.length - 1}`);
        }
      }, icon('plus'), 'Section'),
      d.end ? h('div.rp-end', null, d.end.trim().split('\n')[0]) : null);
    if (focus) {
      const target = el.querySelector<HTMLElement>(focus.includes('.') ? `[data-block="${focus}"]` : `[data-section="${focus}"]`);
      if (target) {
        // scroll only the studio's scroller (scrollIntoView would also shift the shell), and
        // again once thumbnails above have loaded and moved the block
        const reveal = () => {
          const scroller = target.closest<HTMLElement>('.tab-content') ?? document.scrollingElement as HTMLElement;
          const r = target.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
          scroller.scrollTop += r.top - sr.top - Math.max(0, (sr.height - r.height) / 2);
        };
        reveal();
        setTimeout(reveal, 700);
        target.querySelector<HTMLElement>('.rp-rich, textarea, .rp-title')?.focus({ preventScroll: true });
        target.classList.add('rp-flash');
      }
    }
  }

  return {
    el,
    setDoc(d: TexDoc | null): void {
      doc = d;
      render();
    },
    render,
    /** Forget cached thumbnails (figures changed on disk). */
    clearThumbs(): void {
      thumbs.clear();
    }
  };
}

