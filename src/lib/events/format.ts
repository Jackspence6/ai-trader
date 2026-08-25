/**
 * Event Markets formatting.
 *
 * This desk books in rand: the sportsbooks settle in ZAR, stake limits are
 * quoted in ZAR, and a promo's terms are written in ZAR. The Asset Markets desk
 * books in USD for the same reason — that is what its venues settle in.
 *
 * Both are converted to the operator's chosen display currency at render time
 * by `lib/currency`, never stored converted. Keeping each desk's book in its own
 * settlement currency is what lets us tell trading performance apart from
 * currency movement; a rand P&L that silently became dollars is exactly the kind
 * of number someone acts on.
 */

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "";
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ?? "";

/** Rand, whole units by default — cents are noise at the sizes this desk works in. */
export function zar(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `R${v.toLocaleString("en-ZA", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

/** Decimal odds. Always two places: 2.0 and 2.00 are the same price, and a
 *  column of ragged decimals is unreadable at a glance. */
export function odds(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "—";
}

/** Kick-off and quote times are read in South Africa, so they are shown in SAST
 *  regardless of where the browser is. */
export function sastTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function ageSeconds(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

export function durationShort(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/** "TOTALS|2.5" -> "Totals 2.5". The canonical key is built for joins, not eyes. */
export function marketLabel(key: string): string {
  const [type, line] = key.split("|");
  const pretty = (MARKET_LABEL[type] ?? type).toString();
  return line ? `${pretty} ${line}` : pretty;
}

const MARKET_LABEL: Record<string, string> = {
  "1X2": "1X2",
  MONEYLINE_2WAY: "Moneyline",
  DNB: "Draw no bet",
  TOTALS: "Totals",
  HANDICAP: "Handicap",
  ASIAN_HANDICAP: "Asian handicap",
  BTTS: "Both teams to score",
  OUTRIGHT: "Outright",
  BINARY_YESNO: "Yes / No",
  NEGRISK_MULTI: "Multi-outcome",
};

export const TYPE_LABEL: Record<string, string> = {
  bookie_vs_bookie: "Book vs book",
  bookie_vs_polymarket: "Book vs prediction",
  polymarket_internal: "Prediction internal",
  promo_boost: "Boosted price",
  promo_rollover: "Promo rollover",
};

export const URGENCY_LABEL: Record<string, string> = {
  low: "Pre-match",
  medium: "Today",
  high: "Near kick-off",
  critical: "In play",
};
