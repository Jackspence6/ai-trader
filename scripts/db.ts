#!/usr/bin/env tsx
/**
 * Database CLI.
 *
 *   pnpm db:migrate         apply pending migrations
 *   pnpm db:import [days]   replay recorded JSONL into the hypertables
 *   pnpm db:status          connection, schema and row counts
 *
 * All three are safe to re-run. Migrations skip what is applied, the importer
 * is idempotent, and status only reads.
 */

import { closePool, status } from "@/lib/db/client";
import { appliedMigrations, migrate, pendingMigrations, tableCounts } from "@/lib/db/migrate";
import { importDays } from "@/lib/db/import";
import { listDays } from "@/lib/recorder/store";

const cmd = process.argv[2] ?? "status";
const args = process.argv.slice(3);

function fail(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

async function requireDb() {
  const s = await status();
  if (!s.up) {
    fail(
      `Database unreachable — ${s.error}\n` +
        `  Start it with:  docker compose up -d\n` +
        `  Nothing else breaks while it is down; the recorder and dashboard use files.`,
    );
  }
  return s;
}

async function main() {
  switch (cmd) {
    case "migrate": {
      await requireDb();
      const r = await migrate((m) => console.log(`  ${m}`));
      console.log(
        `\n  ${r.applied.length} applied, ${r.skipped.length} already up to date.\n`,
      );
      break;
    }

    case "import": {
      await requireDb();
      const pending = await pendingMigrations();
      if (pending.length > 0) {
        fail(`Schema is behind — run "pnpm db:migrate" first (pending: ${pending.join(", ")})`);
      }
      const days = args.length > 0 ? args : undefined;
      console.log(`\n  Importing ${days ? days.join(", ") : "all recorded days"}…\n`);
      const results = await importDays(days, (m) => console.log(`  ${m}`));
      const read = results.reduce((a, r) => a + r.read, 0);
      const ins = results.reduce((a, r) => a + r.inserted, 0);
      console.log(
        `\n  ${read} rows read, ${ins} inserted, ${read - ins} already present.\n`,
      );
      break;
    }

    case "status": {
      const s = await status();
      console.log("");
      if (!s.up) {
        console.log(`  Database    DOWN — ${s.error}`);
        console.log(`  Start with  docker compose up -d`);
        console.log(
          `\n  Nothing is broken by this. The recorder writes files and the\n` +
            `  dashboard reads files; the database is the analytical store.\n`,
        );
        break;
      }

      console.log(`  Database    ${s.version}`);
      console.log(`  TimescaleDB ${s.timescale ?? "not installed"}`);

      const applied = await appliedMigrations();
      const pending = await pendingMigrations();
      console.log(
        `  Migrations  ${applied.length} applied${pending.length ? `, ${pending.length} PENDING: ${pending.join(", ")}` : ""}`,
      );

      if (applied.length > 0) {
        const counts = await tableCounts();
        console.log("");
        for (const [table, count] of Object.entries(counts)) {
          console.log(
            `  ${table.padEnd(12)}${count < 0 ? "absent" : count.toLocaleString("en-US")}`,
          );
        }

        const recorded = await listDays();
        console.log(
          `\n  ${recorded.length} day${recorded.length === 1 ? "" : "s"} recorded on disk. Load with:  pnpm db:import\n`,
        );
      } else {
        console.log(`\n  No schema yet. Create it with:  pnpm db:migrate\n`);
      }
      break;
    }

    default:
      fail(`Unknown command "${cmd}". Use: migrate | import | status`);
  }

  await closePool();
}

main().catch(async (e) => {
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
  await closePool();
  process.exit(1);
});
