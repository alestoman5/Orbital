// File-name preview for "Send to report" (no DOM, unit-tested).

/** Same rule as sanitizeFigureName in src/report/compile.ts, minus the Windows device-name guard. */
export function sanitizeName(name: string): string {
  let s = String(name ?? '').split(/[\/]/).pop() ?? '';
  s = s.replace(/\.(pdf|png|svg|jpe?g|eps)$/i, '');
  s = s.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^[._-]+/, '').replace(/[._]+$/, '').slice(0, 80);
  return s || 'figure';
}
