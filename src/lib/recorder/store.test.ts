/**
 * Tests for the recording store.
 *
 * The assertions that matter are the durability ones. This is the component
 * whose silent failure is least recoverable — a day of evidence not captured
 * cannot be captured later — so the failure modes it must survive are a torn
 * write from a crash, a mid-day restart, and compaction of an old day.
 *
 * These run against a real temp directory rather than a mocked filesystem,
 * because the behaviour under test *is* the filesystem behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let previousDir: string | undefined;

// Each test gets an isolated directory via RECORDINGS_DIR. The store resolves
// its root per call, so this is honoured without reloading the module.
beforeEach(async () => {
  previousDir = process.env.RECORDINGS_DIR;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rec-test-"));
  process.env.RECORDINGS_DIR = tmp;
});

afterEach(async () => {
  if (previousDir === undefined) delete process.env.RECORDINGS_DIR;
  else process.env.RECORDINGS_DIR = previousDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function load() {
  return await import("./store");
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("dayKey", () => {
  it("is UTC, not local time", async () => {
    const { dayKey } = await load();
    // 23:30 UTC on the 20th is still the 20th regardless of the host timezone.
    expect(dayKey(Date.parse("2026-07-20T23:30:00Z"))).toBe("2026-07-20");
    expect(dayKey(Date.parse("2026-07-21T00:30:00Z"))).toBe("2026-07-21");
  });
});

describe("append and read", () => {
  it("round-trips rows with their envelope", async () => {
    const { append, readDay, dayKey } = await load();
    const ts = Date.parse("2026-07-20T12:00:00Z");
    await append("quotes", [{ a: 1 }, { a: 2 }], ts);

    const rows = await drain(readDay<{ a: number }>("quotes", dayKey(ts)));
    expect(rows).toHaveLength(2);
    expect(rows[0].ts).toBe(ts);
    expect(rows[0].v).toBe(1);
    expect(rows.map((r) => r.data.a)).toEqual([1, 2]);
  });

  it("appends across calls rather than overwriting", async () => {
    // A restart mid-day must not truncate the morning's data.
    const { append, readDay, dayKey } = await load();
    const ts = Date.parse("2026-07-20T12:00:00Z");
    await append("quotes", [{ a: 1 }], ts);
    await append("quotes", [{ a: 2 }], ts);
    await append("quotes", [{ a: 3 }], ts);

    const rows = await drain(readDay<{ a: number }>("quotes", dayKey(ts)));
    expect(rows.map((r) => r.data.a)).toEqual([1, 2, 3]);
  });

  it("writes nothing for an empty batch", async () => {
    const { append, listDays } = await load();
    expect(await append("quotes", [])).toBe(0);
    expect(await listDays()).toEqual([]);
  });

  it("separates streams and days", async () => {
    const { append, readDay, listDays } = await load();
    const d1 = Date.parse("2026-07-20T12:00:00Z");
    const d2 = Date.parse("2026-07-21T12:00:00Z");
    await append("quotes", [{ x: "q" }], d1);
    await append("scan", [{ x: "s" }], d1);
    await append("quotes", [{ x: "q2" }], d2);

    expect(await listDays()).toEqual(["2026-07-20", "2026-07-21"]);
    expect(await drain(readDay("quotes", "2026-07-20"))).toHaveLength(1);
    expect(await drain(readDay("scan", "2026-07-20"))).toHaveLength(1);
    expect(await drain(readDay("scan", "2026-07-21"))).toHaveLength(0);
  });

  it("returns nothing for a day that was never recorded", async () => {
    const { readDay } = await load();
    expect(await drain(readDay("quotes", "1999-01-01"))).toEqual([]);
  });

  it("survives a torn final line from a crash", async () => {
    // The realistic crash signature: the process died mid-write, leaving
    // truncated JSON. The day must stay readable, minus that one line.
    const { append, readDay, recordingsRoot } = await load();
    const ts = Date.parse("2026-07-20T12:00:00Z");
    await append("quotes", [{ a: 1 }, { a: 2 }], ts);
    await fs.appendFile(
      path.join(recordingsRoot(), "2026-07-20", "quotes.jsonl"),
      '{"ts":123,"v":1,"data":{"a":3',
      "utf-8",
    );

    const rows = await drain(readDay<{ a: number }>("quotes", "2026-07-20"));
    expect(rows.map((r) => r.data.a)).toEqual([1, 2]);
  });

  it("skips a corrupt line in the middle and keeps the rest", async () => {
    const { append, readDay, recordingsRoot } = await load();
    const file = path.join(recordingsRoot(), "2026-07-20", "quotes.jsonl");
    const ts = Date.parse("2026-07-20T12:00:00Z");
    await append("quotes", [{ a: 1 }], ts);
    await fs.appendFile(file, "not json at all\n", "utf-8");
    await append("quotes", [{ a: 3 }], ts);

    const rows = await drain(readDay<{ a: number }>("quotes", "2026-07-20"));
    expect(rows.map((r) => r.data.a)).toEqual([1, 3]);
  });
});

describe("stats", () => {
  it("counts lines and bytes per stream", async () => {
    const { append, statsForDay } = await load();
    const ts = Date.parse("2026-07-20T12:00:00Z");
    await append("quotes", [{ a: 1 }, { a: 2 }, { a: 3 }], ts);
    await append("scan", [{ b: 1 }], ts);

    const s = await statsForDay("2026-07-20");
    expect(s.streams.find((x) => x.stream === "quotes")!.lines).toBe(3);
    expect(s.streams.find((x) => x.stream === "scan")!.lines).toBe(1);
    expect(s.totalLines).toBe(4);
    expect(s.totalBytes).toBeGreaterThan(0);
  });

  it("summarises across days and reports the span", async () => {
    const { append, summarise } = await load();
    await append("quotes", [{ a: 1 }], Date.parse("2026-07-18T12:00:00Z"));
    await append("quotes", [{ a: 2 }], Date.parse("2026-07-20T12:00:00Z"));

    const sum = await summarise();
    expect(sum.days).toBe(2);
    expect(sum.firstDay).toBe("2026-07-18");
    expect(sum.lastDay).toBe("2026-07-20");
    expect(sum.totalLines).toBe(2);
  });

  it("reports zero for an empty store rather than throwing", async () => {
    const { summarise } = await load();
    const sum = await summarise();
    expect(sum.days).toBe(0);
    expect(sum.firstDay).toBeNull();
    expect(sum.recordingToday).toBe(false);
  });
});

describe("compaction", () => {
  it("gzips a completed day and keeps it readable", async () => {
    const { append, compactDay, readDay, recordingsRoot } = await load();
    const ts = Date.parse("2026-07-18T12:00:00Z");
    await append("quotes", [{ a: 1 }, { a: 2 }], ts);

    const done = await compactDay("2026-07-18");
    expect(done).toContain("2026-07-18/quotes");

    // Plain file gone, gz present, content unchanged through the reader.
    await expect(
      fs.access(path.join(recordingsRoot(), "2026-07-18", "quotes.jsonl")),
    ).rejects.toThrow();
    const rows = await drain(readDay<{ a: number }>("quotes", "2026-07-18"));
    expect(rows.map((r) => r.data.a)).toEqual([1, 2]);
  });

  it("marks compacted streams in stats", async () => {
    const { append, compactDay, statsForDay } = await load();
    await append("quotes", [{ a: 1 }], Date.parse("2026-07-18T12:00:00Z"));
    await compactDay("2026-07-18");

    const s = await statsForDay("2026-07-18");
    expect(s.streams[0].compressed).toBe(true);
    expect(s.streams[0].lines).toBe(1);
  });

  it("refuses to compact today", async () => {
    // gzip is not append-safe and the recorder is still writing to today.
    const { compactDay, dayKey } = await load();
    await expect(compactDay(dayKey())).rejects.toThrow(/Refusing to compact today/);
  });

  it("is a no-op on a day with no files", async () => {
    const { compactDay } = await load();
    expect(await compactDay("2020-01-01")).toEqual([]);
  });
});
