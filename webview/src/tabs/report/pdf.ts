// PDF rendering for the Report tab with pdf.js: the compiled report (pages
// rendered lazily as they scroll into view, zoom, scroll position kept across
// recompiles) and first-page thumbnails of PDF figures.
//
// Worker: the webview CSP allows workers from the webview source and blob:,
// but a Worker cannot be constructed from a cross-origin resource URL, so the
// worker script is fetched and started from a blob: URL. If that fails, pdf.js
// gets workerSrc and falls back to its in-thread "fake worker" by itself.

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

let workerReady: Promise<'blob' | 'src'> | undefined;
export let workerMode: 'blob' | 'src' | 'none' = 'none';

export function initPdfWorker(assetBase: string): Promise<'blob' | 'src'> {
  workerReady ??= (async () => {
    const src = assetBase + 'pdf.worker.min.mjs';
    pdfjs.GlobalWorkerOptions.workerSrc = src;
    try {
      const code = await (await fetch(src)).text();
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
      workerMode = 'blob';
    } catch (e) {
      console.warn('pdf.js worker from blob failed, using workerSrc', e);
      workerMode = 'src';
    }
    return workerMode as 'blob' | 'src';
  })();
  return workerReady;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  destroy(): Promise<void>;
}

export async function openPdf(assetBase: string, data: Uint8Array): Promise<OpenedPdf> {
  await initPdfWorker(assetBase);
  const task = pdfjs.getDocument({ data });
  return { doc: await task.promise, destroy: () => task.destroy() };
}

/** First page of a PDF drawn into a canvas `width` CSS px wide. */
export async function pdfThumb(assetBase: string, b64: string, width: number): Promise<HTMLCanvasElement> {
  const opened = await openPdf(assetBase, base64ToBytes(b64));
  try {
    const page = await opened.doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = (width / base.width) * Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas }).promise;
    return canvas;
  } finally {
    void opened.destroy();
  }
}

export interface PdfViewer {
  el: HTMLElement;
  /** Show a (new) PDF; keeps the scroll position when `keepScroll`. */
  load(data: Uint8Array, keepScroll: boolean): Promise<number>;
  setZoom(z: number | 'fit'): void;
  zoom(): number | 'fit';
  pageInfo(): { page: number; pages: number };
  onPageChange(cb: (page: number, pages: number) => void): void;
  goTo(page: number): void;
  clear(): void;
  dispose(): void;
}

export function createPdfViewer(assetBase: string, initialZoom: number | 'fit'): PdfViewer {
  const el = document.createElement('div');
  el.className = 'rp-pdf-pages';
  let doc: PDFDocumentProxy | undefined;
  let opened: OpenedPdf | undefined;
  let zoom: number | 'fit' = initialZoom;
  let pages: { box: HTMLElement; w: number; h: number; rendered: number; task?: { cancel(): void } }[] = [];
  let pageCb: (p: number, n: number) => void = () => undefined;
  let gen = 0;
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) void renderPage(Number((e.target as HTMLElement).dataset.page));
    }
  }, { root: el, rootMargin: '600px 0px' });

  const scaleFor = (w: number) => {
    if (zoom === 'fit') return Math.max(0.2, (el.clientWidth - 32) / w);
    return zoom;
  };

  async function renderPage(i: number): Promise<void> {
    const p = pages[i];
    if (!doc || !p) return;
    const scale = scaleFor(p.w);
    if (Math.abs(p.rendered - scale) < 1e-3) return;
    p.rendered = scale;
    const myGen = gen;
    const page = await doc.getPage(i + 1);
    if (myGen !== gen) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    canvas.style.width = `${p.w * scale}px`;
    canvas.style.height = `${p.h * scale}px`;
    p.task?.cancel();
    const task = page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas });
    p.task = task;
    try {
      await task.promise;
    } catch {
      return;   // cancelled
    }
    if (myGen !== gen) return;
    p.box.replaceChildren(canvas);
  }

  function layout(): void {
    for (const p of pages) {
      const s = scaleFor(p.w);
      p.box.style.width = `${p.w * s}px`;
      p.box.style.height = `${p.h * s}px`;
      p.rendered = p.rendered && Math.abs(p.rendered - s) < 1e-3 ? p.rendered : -1;
    }
    // re-render what is visible
    const top = el.scrollTop, bottom = top + el.clientHeight;
    pages.forEach((p, i) => {
      const t = p.box.offsetTop, b = t + p.box.offsetHeight;
      if (b > top - 600 && t < bottom + 600) void renderPage(i);
    });
  }

  function currentPage(): number {
    const mid = el.scrollTop + el.clientHeight / 3;
    let k = 0;
    pages.forEach((p, i) => { if (p.box.offsetTop <= mid) k = i; });
    return k + 1;
  }

  el.addEventListener('scroll', () => pageCb(currentPage(), pages.length), { passive: true });
  const ro = new ResizeObserver(() => { if (zoom === 'fit') layout(); });
  ro.observe(el);

  return {
    el,
    async load(data, keepScroll) {
      const ratioY = el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0;
      const left = el.scrollLeft;
      const nextOpened = await openPdf(assetBase, data);
      const next = nextOpened.doc;
      gen++;
      const old = opened;
      opened = nextOpened;
      doc = next;
      const sizes = [];
      for (let i = 1; i <= next.numPages; i++) {
        const vp = (await next.getPage(i)).getViewport({ scale: 1 });
        sizes.push({ w: vp.width, h: vp.height });
      }
      io.disconnect();
      // keep the old canvases until the new ones are drawn: no flash on recompile
      const oldBoxes = pages.map(p => p.box);
      pages = sizes.map((s, i) => {
        const box = oldBoxes[i] ?? document.createElement('div');
        box.className = 'rp-pdf-page';
        box.dataset.page = String(i);
        return { box, w: s.w, h: s.h, rendered: -1 };
      });
      el.replaceChildren(...pages.map(p => p.box));
      layout();
      pages.forEach(p => io.observe(p.box));
      if (keepScroll) {
        el.scrollTop = ratioY * el.scrollHeight;
        el.scrollLeft = left;
      } else {
        el.scrollTop = 0;
      }
      void old?.destroy();
      pageCb(currentPage(), pages.length);
      return next.numPages;
    },
    setZoom(z) {
      const ratio = el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0;
      zoom = z;
      layout();
      el.scrollTop = ratio * el.scrollHeight;
    },
    zoom: () => zoom,
    pageInfo: () => ({ page: currentPage(), pages: pages.length }),
    onPageChange(cb) {
      pageCb = cb;
    },
    goTo(page) {
      const p = pages[Math.max(0, Math.min(pages.length - 1, page - 1))];
      if (p) el.scrollTop = p.box.offsetTop - 8;
    },
    clear() {
      gen++;
      pages = [];
      el.replaceChildren();
      void opened?.destroy();
      opened = undefined;
      doc = undefined;
    },
    dispose() {
      io.disconnect();
      ro.disconnect();
      void opened?.destroy();
    }
  };
}
