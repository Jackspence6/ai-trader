/**
 * Offline typography — no network at build time.
 *
 * Swapped in by `pnpm build:offline` when the box cannot reach Google Fonts.
 * The interface renders in the system UI and monospace faces; everything else
 * (metrics, spacing, the tabular-figure alignment the tables depend on) is
 * unchanged, because those come from the CSS stacks rather than the webfont.
 */

export const sans = { variable: "font-system-sans" };
export const mono = { variable: "font-system-mono" };
