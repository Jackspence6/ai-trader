/** Number and time formatting for the terminal. Everything is UTC. */

export function usd(n: number, dp = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Compact money for headline tiles: 12.4k, 1.28M */
export function usdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toFixed(2);
}

export function pct(n: number, dp = 2): string {
  return n.toFixed(dp) + "%";
}

export function signed(n: number, dp = 2): string {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(dp);
}

export function signedUsd(n: number, dp = 2): string {
  return (n >= 0 ? "+" : "−") + usd(Math.abs(n), dp);
}

/** Splits a number so the fractional part can be rendered dimmer —
 *  a real trading-terminal touch that materially improves column scanning. */
export function splitNum(n: number, dp = 2): [string, string] {
  const s = Math.abs(n).toFixed(dp);
  const [int, frac] = s.split(".");
  const withSep = Number(int).toLocaleString("en-US");
  return [withSep, frac ?? ""];
}

export function relTime(iso: string, now = Date.now()): string {
  const d = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (d < 5) return "now";
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

export function utcClock(d: Date): string {
  return (
    String(d.getUTCHours()).padStart(2, "0") +
    ":" +
    String(d.getUTCMinutes()).padStart(2, "0") +
    ":" +
    String(d.getUTCSeconds()).padStart(2, "0")
  );
}

export function tone(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-muted";
}
