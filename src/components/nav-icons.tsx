/**
 * Navigation glyphs.
 *
 * Hand-drawn 16×16 strokes rather than an icon library: the drafting aesthetic
 * needs square caps, hairline weight, and geometry that sits on the pixel
 * grid — a rounded-friendly set like Lucide reads as a different instrument.
 * All strokes inherit currentColor so active/hover tinting is free.
 */

const P = {
  command: (
    // Crosshair — the at-a-glance screen puts you on target.
    <>
      <circle cx="8" cy="8" r="4.6" />
      <path d="M8 0.8v3M8 12.2v3M0.8 8h3M12.2 8h3" />
    </>
  ),
  markets: (
    // Three candles.
    <>
      <path d="M3 5v6M3 2.6v1M3 12.4v1" />
      <path d="M8 3.4v4.4M8 11v2" />
      <rect x="6.6" y="7.8" width="2.8" height="3.2" />
      <path d="M13 2.6v2M13 9.6v3.8" />
      <rect x="11.6" y="4.6" width="2.8" height="5" />
    </>
  ),
  performance: (
    // Equity curve with an end register tick.
    <>
      <path d="M1.5 12.5l3.4-3.2 2.6 1.8 4-5.4 3-2.2" />
      <path d="M12.6 2.4h2v2" />
      <path d="M1.5 14.5h13" />
    </>
  ),
  signals: (
    // Radar arcs around a contact.
    <>
      <path d="M2.4 13.6a8 8 0 0 1 8-8" strokeDasharray="2.2 1.6" />
      <path d="M5.2 13.6a5.2 5.2 0 0 1 5.2-5.2" />
      <circle cx="11.6" cy="12.4" r="1.2" />
      <path d="M2.4 13.6h.01" />
    </>
  ),
  positions: (
    // Long above the line, short below — the book around its axis.
    <>
      <path d="M1.5 8h13" strokeDasharray="1.5 1.5" />
      <rect x="3" y="3" width="3.2" height="5" />
      <rect x="9.8" y="8" width="3.2" height="5" />
    </>
  ),
  strategies: (
    // A decision branching.
    <>
      <circle cx="3.4" cy="8" r="1.6" />
      <circle cx="12.6" cy="3.4" r="1.6" />
      <circle cx="12.6" cy="12.6" r="1.6" />
      <path d="M5 8h3.2M8.2 8V3.4h2.8M8.2 8v4.6h2.8" />
    </>
  ),
  allocation: (
    // Capital divided into unequal sleeves.
    <>
      <rect x="1.8" y="1.8" width="12.4" height="12.4" />
      <path d="M9.4 1.8v12.4M1.8 9.4h7.6M9.4 6h5" />
    </>
  ),
  exchanges: (
    // Two venues, flow both ways.
    <>
      <rect x="1.6" y="1.6" width="5" height="5" />
      <rect x="9.4" y="9.4" width="5" height="5" />
      <path d="M11.9 6.6V4.1h-3M4.1 9.4v2.5h3" />
      <path d="M10.4 5.6l1.5-1.5 1.5 1.5M5.6 10.4l-1.5 1.5-1.5-1.5" />
    </>
  ),
  control: (
    // Sliders.
    <>
      <path d="M1.8 4.4h5.4M10.4 4.4h3.8" />
      <rect x="7.2" y="2.9" width="3.2" height="3" />
      <path d="M1.8 11.6h2.6M7.6 11.6h6.6" />
      <rect x="4.4" y="10.1" width="3.2" height="3" />
    </>
  ),
  risk: (
    // Shield with a centre register.
    <>
      <path d="M8 1.6l5.6 2.2v4.4c0 3.4-2.4 5.6-5.6 6.6-3.2-1-5.6-3.2-5.6-6.6V3.8L8 1.6z" />
      <path d="M8 5.4v3.2M8 10.4v.01" />
    </>
  ),
  treasury: (
    // Vault door.
    <>
      <rect x="1.8" y="1.8" width="12.4" height="12.4" />
      <circle cx="8" cy="8" r="3.4" />
      <path d="M8 4.6V6M8 10v1.4M4.6 8H6M10 8h1.4" />
    </>
  ),
  research: (
    // Flask over a baseline of results.
    <>
      <path d="M6.2 1.8v4L2.6 12a1.6 1.6 0 0 0 1.4 2.4h8a1.6 1.6 0 0 0 1.4-2.4L9.8 5.8v-4" />
      <path d="M5 1.8h6" />
      <path d="M4.6 10.4h6.8" strokeDasharray="1.5 1.5" />
    </>
  ),
  system: (
    // The chip everything runs on.
    <>
      <rect x="4" y="4" width="8" height="8" />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" />
      <path d="M6 4V1.8M10 4V1.8M6 14.2V12M10 14.2V12M4 6H1.8M4 10H1.8M14.2 6H12M14.2 10H12" />
    </>
  ),
} as const;

export type NavIconId = keyof typeof P;

export function NavIcon({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const glyph = P[id as NavIconId];
  if (!glyph) return null;
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      aria-hidden
    >
      {glyph}
    </svg>
  );
}
