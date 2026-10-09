// Formatting helpers of the calcs and runs tabs (durations, sizes, ages).
// Header-button spinner too (both tabs).

/** 42 s, 3.1 min, 2.4 h, 3.2 d. */
export function fmtDuration(s: number | undefined | null): string {
  if (s === undefined || s === null || !Number.isFinite(s)) return '–';
  const a = Math.abs(s);
  if (a < 10) return `${s.toFixed(1)} s`;
  if (a < 60) return `${Math.round(s)} s`;
  if (a < 3600) return `${(s / 60).toFixed(1)} min`;
  if (a < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

/** Unit for an axis of durations around `typical` seconds. */
export function durationUnit(typical: number): { unit: string; scale: number } {
  if (typical >= 7200) return { unit: 'h', scale: 3600 };
  if (typical >= 120) return { unit: 'min', scale: 60 };
  return { unit: 's', scale: 1 };
}

export function fmtBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v.toFixed(0) : v < 10 ? v.toFixed(1) : v.toFixed(0)} ${u[i]}`;
}

/** "just now", "5 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function fmtAge(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 3) return 'just now';
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fmtInt = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');

export function pct(part: number, total: number): string {
  if (!total) return '–';
  if (part === 0) return '0';
  const v = (100 * part) / total;
  return v > 0 && v < 0.1 ? '<0.1' : v > 99.9 && v < 100 ? '>99.9' : v.toFixed(v < 10 ? 1 : 0);
}

/** Spinning icon on a header button while work runs (keyframes `calcs-spin` in calcs.css; both tabs' CSS is in the bundle). */
export function spin(btn: HTMLElement, on: boolean): void {
  const ic = btn.querySelector<SVGElement>('svg');
  if (ic) ic.style.animation = on ? 'calcs-spin 0.9s linear infinite' : '';
}
