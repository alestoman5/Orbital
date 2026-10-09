// Browser exports: PNG (SVG rasterized through Image + canvas, Arimo embedded,
// pHYs set to the dpi) and PDF (jsPDF + svg2pdf.js, vector text in Arimo so
// Greek letters and U+2212 survive). toSvg / toCsv are DOM-free (svgExport.ts,
// csv.ts).

import { jsPDF } from 'jspdf';
import { svg2pdf } from 'svg2pdf.js';
import type { ExportOptions, Figure } from './api';
import { svgDocument } from './figure';
import { embeddedFontCss, loadPdfFonts, pdfFamily, subsetOf, subsetsFor, toBase64 } from './fonts';
import { buildForExport, exportFontFamily } from './svgExport';
import { arimoMeasure } from './text';
import { screenTheme, type Theme } from './themes';

const screenFor = (figure: Figure) => (): Theme => screenTheme(document.body, figure);

/** Text content of SVG markup (to find the font subsets it needs). */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, '');
}

// --- PNG -----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Inserts a pHYs chunk (pixels per metre) after IHDR so viewers and Word know the dpi. */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ihdrEnd = 8 + 8 + 13 + 4;
  if (png.length < ihdrEnd || png[12] !== 0x49 || png[13] !== 0x48) {
    return png;
  }
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

/** Rasterized figure as a PNG Blob. */
export async function pngBlob(figure: Figure, options: ExportOptions = {}): Promise<Blob> {
  const dpi = options.dpi ?? 600;
  const b = buildForExport(figure, options, { pxPerUnit: dpi / 72, screenTheme: screenFor(figure) });
  const W = Math.max(1, Math.round((b.widthPt / 72) * dpi));
  const H = Math.max(1, Math.round((b.heightPt / 72) * dpi));
  const arimo = b.theme.preset === 'publication' && b.theme.arimo;
  const fontCss = arimo ? await embeddedFontCss(subsetsFor(textOf(b.model.body))) : '';
  const svg = svgDocument(b.model, {
    width: String(W),
    height: String(H),
    fontFamily: arimo ? `Arimo, ${exportFontFamily(b.theme)}` : b.theme.fontFamily,
    extraDefs: fontCss ? `<style>${fontCss}</style>` : undefined
  });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas is not available');
    }
    if (fontCss) {
      // An SVG image loads its embedded @font-face only when first painted, and
      // paints text invisibly until then: prime it, give the fonts time, redraw.
      const probe = document.createElement('canvas');
      probe.width = probe.height = 8;
      probe.getContext('2d')?.drawImage(img, 0, 0, 8, 8);
      await document.fonts?.ready;
      for (let i = 0; i < 3; i++) {
        await new Promise(res => setTimeout(res, 60));
        probe.getContext('2d')?.drawImage(img, 0, 0, 8, 8);
      }
    }
    if (!options.transparent) {
      ctx.fillStyle = b.theme.bg ?? b.theme.paper;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.drawImage(img, 0, 0, W, H);
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
    if (!blob) {
      throw new Error('PNG encoding failed (figure too large?)');
    }
    const bytes = withPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
    return new Blob([bytes as BlobPart], { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function pngBytes(figure: Figure, options: ExportOptions = {}): Promise<Uint8Array> {
  return new Uint8Array(await (await pngBlob(figure, options)).arrayBuffer());
}

// --- PDF ------------------------------------------------------------------------------

/**
 * Gives every <tspan> of every <text> an absolute x from the Arimo advance
 * widths, with text-anchor resolved to 'start'. svg2pdf would otherwise place
 * the runs by measuring them in the page, which goes wrong for runs set in a
 * different subset font (Greek after Latin) and shifts the following text.
 */
export function absolutizeText(root: Element): void {
  for (const text of [...root.querySelectorAll('text')]) {
    const size = parseFloat(text.getAttribute('font-size') ?? '10');
    const weight = text.getAttribute('font-weight') ?? '';
    const bold = weight === 'bold' || parseInt(weight, 10) >= 600;
    const anchor = text.getAttribute('text-anchor') ?? 'start';
    const x0 = parseFloat(text.getAttribute('x') ?? '0');
    // wrap loose text nodes so every run is a tspan
    for (const node of [...text.childNodes]) {
      if (node.nodeType === 3 && node.textContent) {
        const span = text.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        span.textContent = node.textContent;
        text.replaceChild(span, node);
      }
    }
    const spans = [...text.children].filter(c => c.localName === 'tspan');
    const parts = spans.map(s => {
      const fs = parseFloat(s.getAttribute('font-size') ?? String(size));
      return { s, dx: parseFloat(s.getAttribute('dx') ?? '0'), w: arimoMeasure(s.textContent ?? '', fs, bold) };
    });
    const total = parts.reduce((a, p) => a + p.dx + p.w, 0);
    let cursor = x0 - (anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0);
    for (const p of parts) {
      cursor += p.dx;
      p.s.removeAttribute('dx');
      p.s.setAttribute('x', String(Math.round(cursor * 1000) / 1000));
      cursor += p.w;
    }
    text.setAttribute('text-anchor', 'start');
  }
}

export async function pdfBytes(figure: Figure, options: ExportOptions = {}): Promise<Uint8Array> {
  const fontFor = (cp: number) => pdfFamily(subsetOf(cp));
  const b = buildForExport(figure, options, { pxPerUnit: 6, fontFor, screenTheme: screenFor(figure) });
  const fonts = await loadPdfFonts(subsetsFor(textOf(b.model.body)));
  const w = b.widthPt;
  const h = b.heightPt;
  const markup = svgDocument(b.model, { width: String(w), height: String(h), fontFamily: pdfFamily('latin') });
  const el = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
  if (el.nodeName !== 'svg') {
    throw new Error('Could not parse the figure SVG');
  }
  absolutizeText(el); // PDF text is always set in Arimo
  const doc = new jsPDF({ unit: 'pt', format: [w, h], orientation: w > h ? 'landscape' : 'portrait', compress: true, putOnlyUsedFonts: true });
  for (const font of fonts) {
    doc.addFileToVFS(`${font.family}-Regular.ttf`, toBase64(font.regular));
    doc.addFont(`${font.family}-Regular.ttf`, font.family, 'normal');
    doc.addFileToVFS(`${font.family}-Bold.ttf`, toBase64(font.bold));
    doc.addFont(`${font.family}-Bold.ttf`, font.family, 'bold');
  }
  doc.setFont(pdfFamily('latin'), 'normal');
  // svg2pdf measures text in the page, so the element has to be in the document
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;';
  host.appendChild(el);
  document.body.appendChild(host);
  try {
    await svg2pdf(el, doc, { x: 0, y: 0, width: w, height: h });
  } finally {
    host.remove();
  }
  doc.setProperties({ creator: 'Orbital Studio', title: options.preset === 'screen' ? 'figure (screen)' : 'figure' });
  return new Uint8Array(doc.output('arraybuffer'));
}
