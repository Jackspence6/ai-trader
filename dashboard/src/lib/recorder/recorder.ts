/**
 * The recorder loop.
 *
 * Runs as a standalone process, independent of the dashboard. That separation
 * is deliberate: the dashboard is something you open and close, and the
 * recorder must not stop when you do.
 *
 * What it captures, and why each one:
 *
 *   quotes  — cross-venue prices, spreads, top-of-book, funding rates. The raw
 *             market state our strategies read.
 *   funding — settled funding prints per venue. Lower frequency, higher value:
 *             this is the actual income series for the core strategy, and the
 *             thing a carry backtest is ultimately fitted against.
 *   scan    — every opportunity we scored and what we decided. This is the
 *             evidence base. Market data tells us what happened; the scan log
 *             tells us what we *would have done*, which is the only way to
 *             learn whether predicted edge matches reality before risking
 *             money on it.
 *
 * Failure policy: a cycle that throws is logged and skipped. The loop never
 * exits on a venue error, because a venue being down is precisely the kind of
 * event worth having recorded around.
 */

import { fetchSnapshot, fetchBinanceFundingHistory } from "@/lib/market/venues";
import { UNIVERSE } from "@/lib/market/types";
import { scan } from "@/lib/engine/scanner";
import { readConfig } from "@/lib/engine/store";
import { append, compactDay, dayKey, listDays } from "./store";
import { clearHeartbeat, writeHeartbeat } from "./heartbeat";

export type RecorderOptions = {
  /** How often to capture market quotes, in ms. */
  quoteIntervalMs?: number;
  /** How often to run and record a full scan, in ms. */
  scanIntervalMs?: number;
  /** How often to poll settled funding prints, in ms. */
  fundingIntervalMs?: number;
  /** Emit a line per cycle. */
  verbose?: boolean;
};

const DEFAULTS = {
  // 60s on quotes is a deliberate compromise. Sub-second capture would be
  // needed for a latency-sensitive strategy; we have none and never will at
  // this size (STRATEGY.md §1), and it would multiply storage 60x for data no
  // strategy here can act on.
  quoteIntervalMs: 60_000,
  // Scans are heavier (they fetch funding history per asset) and the decisions
  // they produce change on the scale of minutes, not seconds.
  scanIntervalMs: 5 * 60_000,
  // Funding settles every 1-8h. Polling every 30 min is ample and stays well
  // inside every venue's rate limit.
  fundingIntervalMs: 30 * 60_000,
};

export type RecorderStats = {
  startedAt: number;
  cycles: { quotes: number; scan: number; funding: number };
  rows: { quotes: number; scan: number; funding: number };
  errors: number;
  lastError: string | null;
};

export function createRecorder(opts: RecorderOptions = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const stats: RecorderStats = {
    startedAt: Date.now(),
    cycles: { quotes: 0, scan: 0, funding: 0 },
    rows: { quotes: 0, scan: 0, funding: 0 },
    errors: 0,
    lastError: null,
  };

  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const log = (msg: string) => {
    if (opts.verbose !== false) {
      console.log(`[${new Date().toISOString()}] ${msg}`);
    }
  };

  /**
   * Publish liveness. Written after every cycle so a wedged loop shows up as a
   * stale heartbeat rather than as a healthy one.
   */
  const beat = async () => {
    try {
      await writeHeartbeat({
        pid: process.pid,
        startedAt: stats.startedAt,
        beatAt: Date.now(),
        cycles: stats.cycles,
        rows: stats.rows,
        errors: stats.errors,
        lastError: stats.lastError,
      });
    } catch {
      // A heartbeat failure must never stop recording — the data matters more
      // than our ability to report on it.
    }
  };

  const onError = (where: string, e: unknown) => {
    stats.errors++;
    stats.lastError = `${where}: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[${new Date().toISOString()}] ERROR ${stats.lastError}`);
  };

  async function recordQuotes() {
    try {
      const snap = await fetchSnapshot();
      // Record the venue errors too. A gap in the quote series is ambiguous;
      // an explicit "Bybit was unreachable" row is not.
      const rows = [
        ...snap.quotes,
        ...snap.errors.map((e) => ({
          venue: e.venue,
          asset: "*",
          kind: "error" as const,
          error: e.message,
        })),
      ];
      const n = await append("quotes", rows, snap.asOf);
      stats.cycles.quotes++;
      stats.rows.quotes += n;
      log(
        `quotes  +${n} rows (${snap.quotes.length} quotes, ${snap.errors.length} venue errors)`,
      );
    } catch (e) {
      onError("quotes", e);
    }
    await beat();
  }

  async function recordScan() {
    try {
      const [snapshot, config] = await Promise.all([fetchSnapshot(), readConfig()]);

      const histories = await Promise.allSettled(
        UNIVERSE.map((a) => fetchBinanceFundingHistory(a, config.fundingRegimeWindow)),
      );
      const fundingHistory: Record<string, number[]> = {};
      histories.forEach((h, i) => {
        if (h.status === "fulfilled") {
          fundingHistory[`Binance:${UNIVERSE[i]}`] = h.value.map((r) => r.apr);
        }
      });

      const opportunities = scan({ config, snapshot, fundingHistory });
      const n = await append("scan", opportunities, snapshot.asOf);
      stats.cycles.scan++;
      stats.rows.scan += n;

      const would = opportunities.filter((o) => o.wouldTake).length;
      log(`scan    +${n} rows (${would} would-take)`);
    } catch (e) {
      onError("scan", e);
    }
    await beat();
  }

  async function recordFunding() {
    try {
      const results = await Promise.allSettled(
        UNIVERSE.map(async (asset) => {
          const rows = await fetchBinanceFundingHistory(asset, 10);
          return rows.map((r) => ({ venue: "Binance", asset, ...r }));
        }),
      );
      const rows = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const n = await append("funding", rows);
      stats.cycles.funding++;
      stats.rows.funding += n;
      log(`funding +${n} rows`);
    } catch (e) {
      onError("funding", e);
    }
    await beat();
  }

  /**
   * Gzip any completed day that is still uncompressed.
   *
   * Runs once at startup and then daily. Compaction is skipped for today, so a
   * long-running process compacts yesterday the first time it wakes after
   * midnight.
   */
  async function compactOldDays() {
    try {
      const today = dayKey();
      for (const day of await listDays()) {
        if (day === today) continue;
        const done = await compactDay(day);
        if (done.length) log(`compact ${done.join(", ")}`);
      }
    } catch (e) {
      onError("compact", e);
    }
  }

  async function start() {
    log(
      `recorder starting — quotes ${cfg.quoteIntervalMs / 1000}s · scan ${cfg.scanIntervalMs / 1000}s · funding ${cfg.fundingIntervalMs / 60000}m`,
    );

    await compactOldDays();

    // Fire each stream once immediately so a restart produces data at once
    // rather than after a full interval of silence.
    await Promise.all([recordQuotes(), recordFunding()]);
    await recordScan();

    timers.push(setInterval(recordQuotes, cfg.quoteIntervalMs));
    timers.push(setInterval(recordScan, cfg.scanIntervalMs));
    timers.push(setInterval(recordFunding, cfg.fundingIntervalMs));
    timers.push(setInterval(compactOldDays, 24 * 60 * 60_000));
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearInterval(t);
    // Clearing on a clean shutdown is what lets the dashboard tell "stopped
    // deliberately" apart from "died".
    await clearHeartbeat();
    log(
      `recorder stopped — ${stats.rows.quotes} quote rows, ${stats.rows.scan} scan rows, ${stats.rows.funding} funding rows, ${stats.errors} errors`,
    );
  }

  return { start, stop, stats: () => stats };
}
