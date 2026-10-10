// Inline SVG icons (24x24, stroke = currentColor). Kept as strings so they
// inherit the theme color and need no network/CSP allowance.

const s = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  /** absorption band with sticks */
  spectra: s('<path d="M3 20h18"/><path d="M4 19c3 0 3.5-12 6-12s3 9 5 9 2-5 5-5"/><path d="M7 20v-4M13 20v-8M17 20v-5"/>'),
  /** stacked progress bars */
  calcs: s('<rect x="3" y="4" width="18" height="4" rx="1.5"/><rect x="3" y="10" width="18" height="4" rx="1.5"/><rect x="3" y="16" width="18" height="4" rx="1.5"/><path d="M9 4v4M14 10v4M7 16v4"/>'),
  /** activity / process pulse */
  runs: s('<path d="M3 12h4l2-6 4 12 2-6h6"/>'),
  /** molecule with a measured bond */
  geom: s('<circle cx="6" cy="16" r="2.5"/><circle cx="12" cy="7" r="2.5"/><circle cx="18" cy="16" r="2.5"/><path d="M7.4 13.8 10.6 9.2M13.4 9.2l3.2 4.6"/><path d="M8.5 16h7" stroke-dasharray="1.5 2"/>'),
  /** document with code brackets */
  inputs: s('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m10 12-2 2 2 2M14 12l2 2-2 2"/>'),
  /** network of nodes */
  ml: s('<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="m6.7 7 3.6 3.9M6.7 17l3.6-3.9M13.7 11l3.6-3.9M13.7 13l3.6 3.9"/>'),
  /** page with lines */
  report: s('<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 11h7M9 14h7M9 17h4"/>'),
  /** atomic orbital (p lobes) — brand mark */
  orbital: s('<ellipse cx="12" cy="7" rx="3.2" ry="4.6"/><ellipse cx="12" cy="17" rx="3.2" ry="4.6"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  refresh: s('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>'),
  download: s('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>'),
  copy: s('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  file: s('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  folder: s('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  close: s('<path d="M6 6l12 12M18 6 6 18"/>'),
  play: s('<path d="M7 5v14l12-7z"/>'),
  stop: s('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  check: s('<path d="m5 12 5 5 9-10"/>'),
  warning: s('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>'),
  error: s('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  info: s('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  search: s('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'),
  filter: s('<path d="M4 5h16l-6 7v6l-4 2v-8z"/>'),
  settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  chevronDown: s('<path d="m6 9 6 6 6-6"/>'),
  chevronRight: s('<path d="m9 6 6 6-6 6"/>'),
  external: s('<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
  send: s('<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>'),
  zoomReset: s('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/><path d="M8.5 11h5"/>'),
  terminal: s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/>'),
  trash: s('<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>')
} as const;

export type IconName = keyof typeof ICONS;
