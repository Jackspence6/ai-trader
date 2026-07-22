/**
 * Tests for the database layer.
 *
 * Split by what each test actually needs:
 *
 *   - Migration *loading* and checksum logic is pure and always runs.
 *   - Anything touching Postgres is skipped when the database is unreachable,
 *     because the database is optional by design and a test suite that fails
 *     when Docker is off would train everyone to ignore red.
 *
 * The skipped tests announce themselves rather than passing silently — a
 * quietly-skipped integration test is indistinguishable from one that does not
 * exist.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closePool, query, status } from "./client";
import { loadMigrations, migrate, migrationsDir, pendingMigrations } from "./migrate";
import { daysHeldAbove, navByDay, recordNav } from "./nav";

/* --------------------------------------------------------- pure: loading */

describe("migration loading", () => {
  it("loads .sql files in lexical order", async () => {
    const ms = await loadMigrations();
    expect(ms.length).toBeGreaterThan(0);
    expect(ms[0].name).toBe("001_init.sql");
    const names = ms.map((m) => m.name);
    expect([...names].sort()).toEqual(names);
  });

  it("computes a stable checksum per file", async () => {
    const a = await loadMigrations();
    const b = await loadMigrations();
    expect(a.map((m) => m.checksum)).toEqual(b.map((m) => m.checksum));
    expect(a[0].checksum).toHaveLength(16);
  });

  it("returns nothing when the directory is absent", async () => {
    const prev = process.env.MIGRATIONS_DIR;
    process.env.MIGRATIONS_DIR = path.join(os.tmpdir(), "definitely-not-here");
    try {
      expect(await loadMigrations()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.MIGRATIONS_DIR;
      else process.env.MIGRATIONS_DIR = prev;
    }
  });

  it("resolves the directory from MIGRATIONS_DIR when set", async () => {
    const prev = process.env.MIGRATIONS_DIR;
    process.env.MIGRATIONS_DIR = "/tmp/somewhere";
    try {
      expect(migrationsDir()).toBe("/tmp/somewhere");
    } finally {
      if (prev === undefined) delete process.env.MIGRATIONS_DIR;
      else process.env.MIGRATIONS_DIR = prev;
    }
  });
});

/* ------------------------------------------------- integration: Postgres */

const dbUp = await status()
  .then((s) => s.up)
  .catch(() => false);

if (!dbUp) {
  describe.skip("database integration (SKIPPED — Postgres unreachable)", () => {
    it("start it with: docker compose up -d", () => {});
  });
} else {
  describe("database integration", () => {
    // Every test writes into a dedicated NAV window far in the past so it
    // cannot collide with real recorded data in the same database.
    const BASE = Date.parse("2001-01-01T00:00:00Z");

    beforeAll(async () => {
      await migrate();
      await query("DELETE FROM nav_history WHERE observed_at < '2002-01-01'");
    });

    afterAll(async () => {
      await query("DELETE FROM nav_history WHERE observed_at < '2002-01-01'");
      await closePool();
    });

    it("connects and reports TimescaleDB", async () => {
      const s = await status();
      expect(s.up).toBe(true);
      if (s.up) expect(s.timescale).not.toBeNull();
    });

    it("has no pending migrations after migrating", async () => {
      expect(await pendingMigrations()).toEqual([]);
    });

    it("is idempotent — a second migrate applies nothing", async () => {
      const r = await migrate();
      expect(r.applied).toEqual([]);
      expect(r.skipped.length).toBeGreaterThan(0);
    });

    it("refuses a migration whose contents changed after being applied", async () => {
      // Editing an applied migration leaves environments with silently
      // different schemas, so this must be an error rather than a no-op.
      const prev = process.env.MIGRATIONS_DIR;
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mig-"));
      try {
        await fs.writeFile(path.join(tmp, "001_init.sql"), "SELECT 1;", "utf-8");
        process.env.MIGRATIONS_DIR = tmp;
        await expect(migrate()).rejects.toThrow(/has changed since it was applied/);
      } finally {
        if (prev === undefined) delete process.env.MIGRATIONS_DIR;
        else process.env.MIGRATIONS_DIR = prev;
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("round-trips NAV observations and aggregates them by day", async () => {
      await recordNav(1000, "test", new Date(BASE));
      await recordNav(900, "test", new Date(BASE + 3600_000));
      await recordNav(1100, "test", new Date(BASE + 7200_000));

      const days = await navByDay(10);
      const day = days.find((d) => d.day === "2001-01-01")!;
      expect(day.min).toBe(900);
      expect(day.max).toBe(1100);
      expect(day.close).toBe(1100);
    });

    // Streak assertions pin `asOf` inside the seeded 2001 window. The streak
    // is anchored at the day before `asOf`, so real recorder data elsewhere in
    // the table cannot reach these tests — and they cannot pass by accident on
    // an empty database either.

    it("counts a clean streak of complete days above the threshold", async () => {
      for (let i = 0; i < 5; i++) {
        await recordNav(1000, "test", new Date(BASE + i * 86_400_000));
      }
      // As of Jan 6, the five complete days Jan 1–5 all held.
      expect(await daysHeldAbove(500, new Date(BASE + 5 * 86_400_000))).toBe(5);
    });

    it("uses the daily MINIMUM, so an intraday dip breaks the streak", async () => {
      // The whole point of the hold period: a NAV that spent part of the day
      // underwater has not "held above" the threshold that day.
      await query("DELETE FROM nav_history WHERE observed_at < '2002-01-01'");
      await recordNav(1000, "test", new Date(BASE));
      await recordNav(1000, "test", new Date(BASE + 86_400_000));
      await recordNav(400, "test", new Date(BASE + 86_400_000 + 3600_000)); // dip
      await recordNav(1000, "test", new Date(BASE + 2 * 86_400_000));

      // Streak counts backwards from the most recent complete day and stops at
      // the dip, so only the final day counts.
      expect(await daysHeldAbove(500, new Date(BASE + 3 * 86_400_000))).toBe(1);
    });

    it("breaks the streak on a day with no observations at all", async () => {
      // No data is no evidence: seven qualifying days spread over a patchy
      // month must not satisfy a 7-consecutive-day hold.
      await query("DELETE FROM nav_history WHERE observed_at < '2002-01-01'");
      await recordNav(1000, "test", new Date(BASE)); // Jan 1
      // Jan 2 missing entirely.
      await recordNav(1000, "test", new Date(BASE + 2 * 86_400_000)); // Jan 3
      expect(await daysHeldAbove(500, new Date(BASE + 3 * 86_400_000))).toBe(1);
    });

    it("counts nothing when history stops before yesterday", async () => {
      // Stale history is not evidence about now.
      await query("DELETE FROM nav_history WHERE observed_at < '2002-01-01'");
      await recordNav(1000, "test", new Date(BASE));
      expect(await daysHeldAbove(500, new Date(BASE + 10 * 86_400_000))).toBe(0);
    });

    it("returns zero when nothing clears the threshold", async () => {
      await query("DELETE FROM nav_history WHERE observed_at < '2002-01-01'");
      await recordNav(100, "test", new Date(BASE));
      expect(await daysHeldAbove(500, new Date(BASE + 86_400_000))).toBe(0);
    });

    it("returns zero for a zero or negative threshold", async () => {
      expect(await daysHeldAbove(0)).toBe(0);
      expect(await daysHeldAbove(-5)).toBe(0);
    });

    it("does not duplicate a NAV observation at the same instant", async () => {
      await query("DELETE FROM nav_history WHERE observed_at < '2002-01-01'");
      await recordNav(1000, "test", new Date(BASE));
      await recordNav(9999, "test", new Date(BASE));
      const rows = await query<{ n: string }>(
        "SELECT count(*)::text AS n FROM nav_history WHERE observed_at < '2002-01-01'",
      );
      expect(Number(rows[0].n)).toBe(1);
    });
  });
}
