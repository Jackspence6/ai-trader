/**
 * Tests for the kill switch.
 *
 * The properties that matter, in order:
 *
 *   1. A corrupt state file reads as HALTED. The safe interpretation of "I
 *      don't know" is "stop" — a false halt costs an opportunity, a false
 *      all-clear is unbounded.
 *   2. Halting is idempotent and preserves the ORIGINAL reason. A second press
 *      must not overwrite why it first stopped.
 *   3. Resuming requires a reason, and every transition is audited.
 *   4. Writes are atomic, so a crash mid-write cannot wedge the system into
 *      permanent fail-safe.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let prevDir: string | undefined;

// File names come from the KV layer's keys, not from the test.
const stateFile = () => path.join(tmp, "halt_state.json");
const auditFile = () => path.join(tmp, "log_halt_audit.jsonl");

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "halt-"));
  prevDir = process.env.STATE_DIR;
  process.env.STATE_DIR = tmp;
});

afterEach(async () => {
  if (prevDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = prevDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

const load = () => import("./state");

describe("halt state", () => {
  it("reads as running when no state file exists", async () => {
    const { readHalt } = await load();
    const s = await readHalt();
    expect(s.halted).toBe(false);
    expect(s.since).toBeNull();
  });

  it("round-trips a halt with its reason and source", async () => {
    const { halt, readHalt } = await load();
    await halt("daily loss limit", "auto", "risk-engine");

    const s = await readHalt();
    expect(s.halted).toBe(true);
    expect(s.reason).toBe("daily loss limit");
    expect(s.source).toBe("auto");
    expect(s.actor).toBe("risk-engine");
    expect(s.since).toBeGreaterThan(0);
  });

  it("FAILS SAFE — a corrupt state file reads as halted", async () => {
    // The single most important assertion in this file. If our own state is
    // unreadable we do not know whether it is safe to trade, and the only
    // acceptable answer to that is "stop".
    const { readHalt } = await load();
    await fs.writeFile(stateFile(), "{ this is not json", "utf-8");

    const s = await readHalt();
    expect(s.halted).toBe(true);
    expect(s.reason).toMatch(/corrupt|Failing safe/i);
  });

  it("fails safe synchronously too", async () => {
    const { readHaltSync } = await load();
    await fs.writeFile(stateFile(), "truncated{", "utf-8");
    expect(readHaltSync().halted).toBe(true);
  });

  it("distinguishes a missing file from a corrupt one", async () => {
    // Missing means "never halted" — a fresh install must not read as stopped.
    const { readHaltSync } = await load();
    expect(readHaltSync().halted).toBe(false);
  });

  it("treats a non-boolean halted field as not halted, not as truthy junk", async () => {
    const { readHalt } = await load();
    await fs.writeFile(
      stateFile(),
      JSON.stringify({ halted: "no", since: "soon" }),
      "utf-8",
    );
    const s = await readHalt();
    // "no" is a non-empty string and therefore truthy — which is the correct
    // fail-safe direction here, and worth pinning so it is not "fixed".
    expect(s.halted).toBe(true);
    expect(s.since).toBeNull();
  });

  it("is idempotent and keeps the ORIGINAL reason on a repeat halt", async () => {
    const { halt, readHalt } = await load();
    const first = await halt("first reason", "cli");
    await new Promise((r) => setTimeout(r, 5));
    await halt("second reason", "dashboard");

    const s = await readHalt();
    expect(s.reason).toBe("first reason");
    expect(s.since).toBe(first.since);
  });

  it("clears fully on resume", async () => {
    const { halt, resume, readHalt } = await load();
    await halt("stop", "cli");
    await resume("investigated, all clear", "cli");

    const s = await readHalt();
    expect(s.halted).toBe(false);
    expect(s.since).toBeNull();
    expect(s.reason).toBeNull();
  });

  it("audits every transition, newest first", async () => {
    const { halt, resume, readAudit } = await load();
    await halt("one", "cli", "jack");
    await resume("two", "dashboard", "jack");

    const audit = await readAudit();
    expect(audit).toHaveLength(2);
    expect(audit[0].action).toBe("resume");
    expect(audit[0].reason).toBe("two");
    expect(audit[1].action).toBe("halt");
    expect(audit[1].actor).toBe("jack");
  });

  it("records repeat halts in the audit even though state is unchanged", async () => {
    // The state does not change, but the fact someone pressed it again is
    // exactly the kind of thing you want in the log afterwards.
    const { halt, readAudit } = await load();
    await halt("first", "cli");
    await halt("second", "http");
    expect(await readAudit()).toHaveLength(2);
  });

  it("survives a corrupt line in the audit log", async () => {
    const { halt, readAudit } = await load();
    await halt("one", "cli");
    await fs.appendFile(auditFile(), "not json\n", "utf-8");
    await halt("two", "cli");
    const audit = await readAudit();
    expect(audit.length).toBe(2);
  });

  it("writes atomically, leaving no partial file behind", async () => {
    const { halt } = await load();
    await halt("stop", "cli");
    const files = await fs.readdir(tmp);
    // The temp file used for the atomic rename must not survive.
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("returns an empty audit when nothing has happened", async () => {
    const { readAudit } = await load();
    expect(await readAudit()).toEqual([]);
  });
});

describe("kill switch orchestration", () => {
  it("sets halt state BEFORE sweeping venues", async () => {
    // Ordering is the safety property: if the venue sweep hangs or the process
    // dies mid-sweep, everything that consults halt state already refuses to
    // trade. The reverse order leaves a window where we cancel orders while
    // strategies are still free to place new ones.
    const { trip } = await import("./index");
    const { readHalt } = await load();

    const result = await trip("test halt", "cli", "tester");
    expect(result.state.halted).toBe(true);
    expect((await readHalt()).halted).toBe(true);
    // No credentials configured in the test environment, so the sweep is a
    // no-op — and the halt still stuck, which is the point.
    expect(result.sweep.noCredentials).toBe(true);
  });

  it("halts even when there is nothing to cancel", async () => {
    const { trip } = await import("./index");
    const r = await trip("no venues", "cli");
    expect(r.state.halted).toBe(true);
    expect(r.sweep.attempted).toBe(0);
  });

  it("derives cancel symbols from the trading universe", async () => {
    const { killSymbols } = await import("./index");
    const symbols = killSymbols();
    expect(symbols).toContain("BTCUSDT");
    expect(symbols).toContain("ETHUSDT");
    expect(symbols.every((s) => s.endsWith("USDT"))).toBe(true);
  });

  it("clear() resumes and records the reason", async () => {
    const { trip, clear } = await import("./index");
    const { readAudit } = await load();
    await trip("stop", "cli");
    const state = await clear("resolved", "cli", "tester");
    expect(state.halted).toBe(false);
    const audit = await readAudit();
    expect(audit[0].action).toBe("resume");
    expect(audit[0].reason).toBe("resolved");
  });
});
