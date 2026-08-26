#!/usr/bin/env tsx
/**
 * Preflight.
 *
 * Run before the first start on a new machine, and again any time something
 * looks wrong. It answers one question — *would this system work here right
 * now* — and it answers it by trying, not by reading configuration.
 *
 * Three principles shape what it does and does not do.
 *
 * **Every check names its consequence.** "Binance unreachable" is not
 * actionable on its own; "Binance unreachable — crypto carry cannot be scored,
 * the loop will idle" tells you whether to fix it before starting or start
 * anyway. Checks are therefore graded: a FAIL stops you, a WARN is a capability
 * you will be missing, an INFO is a fact worth knowing.
 *
 * **It never writes anything.** A preflight that mutates state is one you
 * hesitate to run, and the moment you hesitate is the moment it stops being
 * useful. No migrations, no config writes, no orders.
 *
 * **It refuses to guess about money.** The execution mode is read from the same
 * seam the engine uses rather than re-derived here, because two implementations
 * of "are we live?" is exactly the bug this check exists to catch.
 */

// Configuration first: every entry point must see the same .env.local the
// console does, or the two run against different databases from one directory.
import "./env";

import { databaseConfigured, databaseUrl } from "../src/lib/db/client";
import { describeExecutionMode } from "../src/lib/oms/venues/resolve";

type Grade = "PASS" | "WARN" | "FAIL" | "INFO";

type Check = {
  name: string;
  grade: Grade;
  detail: string;
  /** What you lose if this is not fixed. Empty for PASS and INFO. */
  consequence?: string;
};

const results: Check[] = [];
const add = (c: Check) => results.push(c);

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  bold: "\x1b[1m",
};

const MARK: Record<Grade, string> = {
  PASS: `${C.green}✓${C.reset}`,
  WARN: `${C.yellow}!${C.reset}`,
  FAIL: `${C.red}✗${C.reset}`,
  INFO: `${C.blue}·${C.reset}`,
};

async function probe(
  name: string,
  url: string,
  consequence: string,
  { timeoutMs = 8000, optional = false } = {},
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const ms = Date.now() - started;
    if (res.ok) {
      add({ name, grade: "PASS", detail: `${res.status} in ${ms}ms` });
    } else {
      add({
        name,
        grade: optional ? "WARN" : "FAIL",
        detail: `HTTP ${res.status} in ${ms}ms`,
        consequence,
      });
    }
  } catch (err) {
    const why = (err as Error).name === "AbortError" ? `no answer in ${timeoutMs}ms` : (err as Error).message;
    add({ name, grade: optional ? "WARN" : "FAIL", detail: why, consequence });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ checks */

async function checkRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  add({
    name: "Node runtime",
    grade: major >= 22 ? "PASS" : "FAIL",
    detail: `v${process.versions.node}`,
    consequence: "The app targets Node 22+; older runtimes fail at build, not at start.",
  });
}

async function checkClock() {
  // Funding settles on venue time and matches kick off on SAST. A box thirty
  // seconds behind mis-windows both desks — and does it silently, because
  // every timestamp still looks plausible.
  const started = Date.now();
  try {
    const res = await fetch("https://api.binance.com/api/v3/time", {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    const rtt = Date.now() - started;
    const { serverTime } = (await res.json()) as { serverTime: number };
    // Half the round trip is the best estimate of one-way latency.
    const skew = Math.abs(Date.now() - rtt / 2 - serverTime);
    add({
      name: "Clock skew",
      grade: skew < 2000 ? "PASS" : skew < 10_000 ? "WARN" : "FAIL",
      detail: `${skew}ms against exchange time (rtt ${rtt}ms)`,
      consequence:
        "Signed exchange requests are rejected outside a few seconds of skew, and funding windows are mis-attributed. Run NTP.",
    });
  } catch {
    add({
      name: "Clock skew",
      grade: "WARN",
      detail: "could not reach a time source",
      consequence: "Skew is unverified. If venue calls later fail authentication, check this first.",
    });
  }
}

async function checkDatabase() {
  if (!databaseConfigured()) {
    add({
      name: "Database",
      grade: "WARN",
      detail: "DATABASE_URL not set — using the local default",
      consequence:
        "Fine for a Compose bring-up. Anything else and both desks will write to a database nobody meant.",
    });
  }
  const url = databaseUrl();
  const safe = url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
  try {
    const { getPool } = await import("../src/lib/db/client");
    const client = await getPool().connect();
    try {
      const { rows } = await client.query("select current_database() as db, now() as now");
      add({ name: "Database reachable", grade: "PASS", detail: `${rows[0].db} · ${safe}` });

      const { rows: schemas } = await client.query(
        "select nspname from pg_namespace where nspname in ('public','events')",
      );
      const names = schemas.map((r: { nspname: string }) => r.nspname);
      add({
        name: "Event Markets schema",
        grade: names.includes("events") ? "PASS" : "WARN",
        detail: names.includes("events") ? "present" : "missing",
        consequence: "Run `pnpm db:migrate`. Until then the event desk's board has nothing to read.",
      });
    } finally {
      client.release();
    }
  } catch (err) {
    add({
      name: "Database reachable",
      grade: "FAIL",
      detail: `${(err as Error).message} · ${safe}`,
      consequence:
        "No NAV history, no capital ladder, no event board. Start it with `docker compose up -d`.",
    });
  }
}

async function checkFeeds() {
  await Promise.all([
    probe("Binance spot", "https://api.binance.com/api/v3/ping", "Crypto carry cannot be scored on Binance."),
    probe("Binance futures", "https://fapi.binance.com/fapi/v1/ping", "Funding rates are unavailable; L1 carry idles."),
    probe("Bybit", "https://api.bybit.com/v5/market/time", "One fewer venue to compare funding across.", { optional: true }),
    probe("OKX", "https://www.okx.com/api/v5/public/time", "One fewer venue to compare funding across.", { optional: true }),
    probe(
      "Hyperliquid",
      "https://api.hyperliquid.xyz/info",
      "One fewer venue to compare funding across.",
      { optional: true },
    ),
    probe(
      "ECB reference rates",
      "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR",
      "FX carry and trend cannot be scored at all — the whole forex book idles.",
    ),
    probe(
      "Polymarket",
      "https://clob.polymarket.com/",
      "The event desk loses its prediction-market side. Geoblocked from US IPs.",
      { optional: true },
    ),
    probe(
      "Sunbet odds (Kambi)",
      "https://eu.offering-api.kambicdn.com/offering/v2018/siwc/listView/football.json?channel_id=1&client_id=200&lang=en_ZA&market=ZA",
      "One of two bookmakers on the event desk. Expect this to fail outside South Africa.",
      { optional: true },
    ),
    probe(
      "Betway odds",
      "https://www.betway.co.za/sportsapi/br/v1/Feeds/RegionsAndLeagues/soccer?countryCode=ZA",
      "The other bookmaker. Sits behind Akamai; a 403 here means the WAF, not the network.",
      { optional: true },
    ),
  ]);
}

function checkExecution() {
  const { mode, reason } = describeExecutionMode();
  add({
    name: "Execution mode",
    grade: mode === "live" ? "WARN" : "INFO",
    detail: `${mode.toUpperCase()} — ${reason}`,
    consequence:
      mode === "live"
        ? "Real money. Orders from this process reach a real exchange."
        : undefined,
  });
}

function checkSecrets() {
  const required: [string, string][] = [
    ["SITE_PASSWORD", "The console fails closed without it and will refuse to serve any page."],
  ];
  const optional: [string, string][] = [
    ["TELEGRAM_BOT_TOKEN", "Alerts are written to the log instead of sent."],
    ["TELEGRAM_CHANNEL_ID", "Alerts have nowhere to go even with a token."],
    ["ADMIN_TOKEN", "The event desk's migration endpoint stays closed. That is safe, not broken."],
  ];
  for (const [key, consequence] of required) {
    add({
      name: key,
      grade: process.env[key] ? "PASS" : "FAIL",
      detail: process.env[key] ? "set" : "missing",
      consequence,
    });
  }
  for (const [key, consequence] of optional) {
    add({
      name: key,
      grade: process.env[key] ? "PASS" : "WARN",
      detail: process.env[key] ? "set" : "not set",
      consequence,
    });
  }
}

/* ------------------------------------------------------------------- run */

async function main() {
  const t0 = Date.now();
  console.log(`\n${C.bold}MERIDIAN PREFLIGHT${C.reset}${C.dim}  ${new Date().toISOString()}${C.reset}\n`);

  await checkRuntime();
  checkSecrets();
  checkExecution();
  await checkDatabase();
  await checkClock();
  await checkFeeds();

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`  ${MARK[r.grade]} ${r.name.padEnd(width)}  ${C.dim}${r.detail}${C.reset}`);
    if (r.consequence && (r.grade === "FAIL" || r.grade === "WARN")) {
      console.log(`    ${C.dim}↳ ${r.consequence}${C.reset}`);
    }
  }

  const fails = results.filter((r) => r.grade === "FAIL");
  const warns = results.filter((r) => r.grade === "WARN");
  console.log(
    `\n  ${results.length} checks in ${Date.now() - t0}ms · ` +
      `${C.green}${results.filter((r) => r.grade === "PASS").length} pass${C.reset} · ` +
      `${C.yellow}${warns.length} warn${C.reset} · ` +
      `${C.red}${fails.length} fail${C.reset}\n`,
  );

  if (fails.length > 0) {
    console.log(`${C.red}${C.bold}  Do not start yet.${C.reset} The failures above are the reason.\n`);
    process.exit(1);
  }
  if (warns.length > 0) {
    console.log(`${C.yellow}  Startable, with the capabilities above missing.${C.reset}\n`);
  } else {
    console.log(`${C.green}  Ready.${C.reset}\n`);
  }
}

main().catch((err) => {
  console.error("preflight itself failed:", err);
  process.exit(1);
});
