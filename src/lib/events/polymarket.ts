// Polymarket client for the serverless scanner (Gamma discovery + CLOB books/fees).
//
// Mirrors backend/oddsengine/venues/polymarket/*.py, including its defensive
// parsing: Gamma returns array fields as JSON-encoded STRINGS, prices as strings,
// negRisk is sometimes absent, and book side ordering must never be trusted.
//
// NOTE: this runs on Vercel (which can reach Polymarket). It cannot be exercised
// from the authoring sandbox, whose egress blocks polymarket.com — so every parser
// here is covered by fixture tests in scripts/test-polymarket-parsing.mjs.

import { effectiveBuyPrice, feeRateForCategory, type BookLevel } from "./arb";

export const GAMMA_URL = process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com";
export const CLOB_URL = process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com";

export function asList(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function asNum(value: unknown, fallback: number | null = null): number | null {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

export interface ParsedMarket {
  conditionId: string;
  question: string;
  slug: string;
  outcomes: string[];
  tokenIds: string[];
  negRisk: boolean;
  closed: boolean;
  category: string | null;
  eventId: string | null;
  eventTitle: string | null;
  endDate: string | null;
}

export function parseGammaMarket(m: Record<string, unknown>, event?: Record<string, unknown>): ParsedMarket | null {
  const tokenIds = asList(m.clobTokenIds).map(String);
  const conditionId = String(m.conditionId ?? m.condition_id ?? m.id ?? "");
  if (!conditionId || tokenIds.length === 0) return null;

  let category = (m.category ?? event?.category ?? null) as string | null;
  if (!category && event) {
    const tags = asList(event.tags).map((t) =>
      typeof t === "object" && t !== null ? String((t as Record<string, unknown>).slug ?? "") : String(t),
    ).filter(Boolean);
    category = tags[0] ?? null;
  }
  return {
    conditionId,
    question: String(m.question ?? m.title ?? ""),
    slug: String(m.slug ?? event?.slug ?? ""),
    outcomes: asList(m.outcomes).map(String),
    tokenIds,
    negRisk: asBool(m.negRisk ?? event?.negRisk),
    closed: asBool(m.closed),
    category: category ? String(category).toLowerCase() : null,
    eventId: event ? String(event.id ?? "") || null : null,
    eventTitle: event ? String(event.title ?? "") || null : null,
    endDate: (m.endDate ?? event?.endDate ?? null) as string | null,
  };
}

export interface ParsedBook { tokenId: string; bids: BookLevel[]; asks: BookLevel[] }

function levels(raw: unknown): BookLevel[] {
  const out: BookLevel[] = [];
  for (const lvl of asList(raw)) {
    let price: number | null = null;
    let size: number | null = null;
    if (typeof lvl === "object" && lvl !== null && !Array.isArray(lvl)) {
      const o = lvl as Record<string, unknown>;
      price = asNum(o.price); size = asNum(o.size);
    } else if (Array.isArray(lvl) && lvl.length >= 2) {
      price = asNum(lvl[0]); size = asNum(lvl[1]);
    }
    if (price == null || size == null || price <= 0 || size <= 0) continue;
    out.push({ price, size });
  }
  return out;
}

/** Parse a CLOB book. Re-sorts both sides; rejects a crossed book as corrupt. */
export function parseBook(payload: Record<string, unknown>, fallbackTokenId?: string): ParsedBook | null {
  const tokenId = String(payload.asset_id ?? payload.token_id ?? payload.market ?? fallbackTokenId ?? "");
  if (!tokenId) return null;
  const bids = levels(payload.bids ?? payload.buys).sort((a, b) => b.price - a.price);
  const asks = levels(payload.asks ?? payload.sells).sort((a, b) => a.price - b.price);
  if (bids.length && asks.length && bids[0].price > asks[0].price) return null;
  return { tokenId, bids, asks };
}

export function bestAsk(book: ParsedBook | null): number | null {
  return book?.asks.length ? book.asks[0].price : null;
}

/** Parse /fee-rate. Endpoint wins over the docs table; accepts bps or fraction. */
export function parseFeeRate(payload: unknown, fallback: number): number {
  if (payload == null) return fallback;
  if (typeof payload === "number" || typeof payload === "string") {
    const v = asNum(payload);
    if (v == null) return fallback;
    return v > 1 ? v / 10_000 : v;
  }
  if (typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    for (const key of ["fee_rate_bps", "feeRateBps", "taker_fee_bps", "takerFeeBps", "fee_rate", "feeRate", "taker"]) {
      if (key in o) {
        const v = asNum(o[key]);
        if (v == null) continue;
        return key.toLowerCase().includes("bps") || v > 1 ? v / 10_000 : v;
      }
    }
  }
  return fallback;
}

// ------------------------------------------------------------------- fetching

async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchEvents(tagSlug: string, limit = 40): Promise<Record<string, unknown>[]> {
  const url = `${GAMMA_URL}/events?closed=false&limit=${limit}&tag_slug=${encodeURIComponent(tagSlug)}`;
  const data = await getJson(url);
  const list = Array.isArray(data) ? data : ((data as Record<string, unknown>)?.data as unknown[]) ?? [];
  return list as Record<string, unknown>[];
}

export async function fetchBook(tokenId: string): Promise<ParsedBook | null> {
  try {
    const data = await getJson(`${CLOB_URL}/book?token_id=${encodeURIComponent(tokenId)}`);
    return parseBook(data as Record<string, unknown>, tokenId);
  } catch {
    return null;
  }
}

const feeCache = new Map<string, number>();

export async function fetchFeeRate(tokenId: string, fallback: number): Promise<number> {
  if (feeCache.has(tokenId)) return feeCache.get(tokenId)!;
  let rate = fallback;
  try {
    const data = await getJson(`${CLOB_URL}/fee-rate?token_id=${encodeURIComponent(tokenId)}`);
    rate = parseFeeRate(data, fallback);
  } catch {
    rate = fallback;
  }
  feeCache.set(tokenId, rate);
  return rate;
}

export { feeRateForCategory, effectiveBuyPrice };
