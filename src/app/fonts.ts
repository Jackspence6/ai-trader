/**
 * Typography — self-hosted, so the build never depends on the network.
 *
 * This used to call `next/font/google`, which fetches the font files at build
 * time. On a box without outbound network that fails the build with a font
 * error and nothing else useful, and the workaround — swapping in a
 * system-font module for offline builds — turned out to be worse than the
 * problem: the swap is stateful, and a build interrupted before it swapped
 * back leaves the repo silently rendering in Helvetica. That is exactly what
 * happened, and it survived several commits without anyone noticing, because
 * a console in the wrong typeface still looks like a console.
 *
 * The files are vendored in ./fonts (88KB for both, latin subset, variable
 * weight axis) under the SIL Open Font License, which is included beside them.
 * There is now no font path that depends on the network, no swap, and no state
 * — the typeface a build produces is the typeface in the repository.
 *
 * The CSS fallback stacks in globals.css still matter: if a face fails to load
 * at runtime the interface degrades to a system UI face and a system
 * monospace, not to Times New Roman — which on a screen full of tabular
 * figures is the difference between "different" and "broken".
 */

import localFont from "next/font/local";

export const sans = localFont({
  src: "./fonts/inter-latin-variable.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
  // Metric-adjusted fallback: the system face is scaled to Inter's metrics so
  // a swap does not reflow a table mid-render.
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
  adjustFontFallback: "Arial",
});

export const mono = localFont({
  src: "./fonts/jetbrains-mono-latin-variable.woff2",
  variable: "--font-jb",
  display: "swap",
  weight: "100 800",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
  adjustFontFallback: false,
});
