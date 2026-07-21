/**
 * Recording store — append-only event log on local disk.
 *
 * DESIGN.md §10 puts the recorder in P0 because every day it is not running is
 * a day of data we can never recover. That argument only holds if the recorder
 * actually stays up, which is why this writes to plain files rather than to
 * Postgres: a database daemon is one more thing that can be down when the
 * machine wakes from sleep, and the failure is silent.
 *
 * Format: newline-delimited JSON, one file per (day, stream). Append-only,
 * never rewritten. That gives us:
 *   - crash safety — a torn write loses at most the last line, and the reader
 *     skips unparseable lines rather than failing the whole day
 *   - trivial migration — importing into TimescaleDB later is a straight replay
 *     of each line, in order, with no transformation
 *   - inspectability — `grep`, `wc -l` and `jq` all work on it today
 *
 * Volume is modest at our cadence: roughly 15–20 MB/day uncompressed, which
 * compresses about 10x. `compactDay` gzips completed days.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import path from "node:path";

/**
 * The streams we record.
 *
 * `scan` is the one that matters most and is easy to overlook. Market data
 * alone tells us what happened; the scan log tells us what *we would have
 * done*, which is the only way to find out whether our predicted edge matches
 * reality before risking capital on it.
 */
export type Stream = "quotes" | "funding" | "scan";

export const STREAMS: Stream[] = ["quotes", "funding", "scan"];

export type RecordEnvelope<T> = {
  /** Milliseconds since epoch, when we wrote it. */
  ts: number;
  /** Schema version, so a later reader can handle old files. */
  v: 1;
  data: T;
};

/**
 * Where recordings live.
 *
 * Resolved per call rather than bound at module load, and overridable via
 * `RECORDINGS_DIR`. Binding it at import time would fix the path to whatever
 * the process's working directory happened to be on first require, which makes
 * the store impossible to point at an external disk or a mounted volume — and
 * that is exactly what you want when a year of recordings outgrows the box.
 */
export function recordingsRoot(): string {
  return (
    process.env.RECORDINGS_DIR ?? path.join(process.cwd(), ".data", "recordings")
  );
}

/** UTC day key, e.g. "2026-07-20". Everything in this system is UTC. */
export function dayKey(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function fileFor(stream: Stream, day: string, gz = false): string {
  return path.join(recordingsRoot(), day, `${stream}.jsonl${gz ? ".gz" : ""}`);
}

/**
 * Append records to a stream.
 *
 * One `writeFile` in append mode per call, batching all rows into a single
 * syscall. Opening per batch rather than holding a handle keeps the recorder
 * restartable at any moment without a flush step.
 */
export async function append<T>(
  stream: Stream,
  rows: T[],
  ts: number = Date.now(),
): Promise<number> {
  if (rows.length === 0) return 0;

  const day = dayKey(ts);
  await fs.mkdir(path.join(recordingsRoot(), day), { recursive: true });

  const payload =
    rows
      .map((data) => JSON.stringify({ ts, v: 1, data } satisfies RecordEnvelope<T>))
      .join("\n") + "\n";

  await fs.appendFile(fileFor(stream, day), payload, "utf-8");
  return rows.length;
}

/**
 * Read a day's stream.
 *
 * Transparently reads the gzipped file when the plain one is absent, so
 * compaction is invisible to callers. Unparseable lines are skipped rather than
 * thrown on — a single torn line from a crash must not make the day unreadable.
 */
export async function* readDay<T>(
  stream: Stream,
  day: string,
): AsyncGenerator<RecordEnvelope<T>> {
  const plain = fileFor(stream, day);
  const gz = fileFor(stream, day, true);

  let input: NodeJS.ReadableStream;
  try {
    await fs.access(plain);
    input = createReadStream(plain);
  } catch {
    try {
      await fs.access(gz);
      input = createReadStream(gz).pipe(createGunzip());
    } catch {
      return;
    }
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as RecordEnvelope<T>;
    } catch {
      // Torn or partial line — skip it and keep the rest of the day.
      continue;
    }
  }
}

/** Days that have at least one recording, oldest first. */
export async function listDays(): Promise<string[]> {
  try {
    const entries = await fs.readdir(recordingsRoot(), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export type StreamStats = {
  stream: Stream;
  lines: number;
  bytes: number;
  compressed: boolean;
};

export type DayStats = {
  day: string;
  streams: StreamStats[];
  totalBytes: number;
  totalLines: number;
};

async function countLines(file: string, gzipped: boolean): Promise<number> {
  let n = 0;
  const input = gzipped
    ? createReadStream(file).pipe(createGunzip())
    : createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n++;
  return n;
}

export async function statsForDay(day: string): Promise<DayStats> {
  const streams: StreamStats[] = [];

  for (const stream of STREAMS) {
    for (const gz of [false, true]) {
      const file = fileFor(stream, day, gz);
      try {
        const st = await fs.stat(file);
        streams.push({
          stream,
          lines: await countLines(file, gz),
          bytes: st.size,
          compressed: gz,
        });
        break;
      } catch {
        continue;
      }
    }
  }

  return {
    day,
    streams,
    totalBytes: streams.reduce((a, s) => a + s.bytes, 0),
    totalLines: streams.reduce((a, s) => a + s.lines, 0),
  };
}

export type RecordingSummary = {
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  totalBytes: number;
  totalLines: number;
  perDay: DayStats[];
  /** True when today has recent data — the honest "is it running?" signal. */
  recordingToday: boolean;
  lastWriteTs: number | null;
};

/**
 * Summarise everything recorded.
 *
 * `limitDays` bounds the work: counting lines means reading every byte, and a
 * year of recordings is not something to scan on every dashboard poll.
 */
export async function summarise(limitDays = 14): Promise<RecordingSummary> {
  const all = await listDays();
  const recent = all.slice(-limitDays);
  const perDay = await Promise.all(recent.map(statsForDay));

  let lastWriteTs: number | null = null;
  const today = dayKey();
  if (all.includes(today)) {
    for (const stream of STREAMS) {
      try {
        const st = await fs.stat(fileFor(stream, today));
        const t = st.mtimeMs;
        if (lastWriteTs === null || t > lastWriteTs) lastWriteTs = t;
      } catch {
        continue;
      }
    }
  }

  return {
    days: all.length,
    firstDay: all[0] ?? null,
    lastDay: all[all.length - 1] ?? null,
    totalBytes: perDay.reduce((a, d) => a + d.totalBytes, 0),
    totalLines: perDay.reduce((a, d) => a + d.totalLines, 0),
    perDay,
    // Ten minutes is generous against a 60s cadence, so a true reading here
    // means the loop is genuinely alive rather than merely recently alive.
    recordingToday: lastWriteTs !== null && Date.now() - lastWriteTs < 10 * 60_000,
    lastWriteTs,
  };
}

/**
 * Gzip a completed day's files in place.
 *
 * Refuses to compact today, because the recorder is still appending to it and
 * gzip is not append-safe.
 */
export async function compactDay(day: string): Promise<string[]> {
  if (day === dayKey()) {
    throw new Error("Refusing to compact today — the recorder is still appending");
  }

  const done: string[] = [];
  for (const stream of STREAMS) {
    const plain = fileFor(stream, day);
    const gz = fileFor(stream, day, true);
    try {
      await fs.access(plain);
    } catch {
      continue;
    }
    await pipeline(createReadStream(plain), createGzip(), createWriteStream(gz));
    await fs.unlink(plain);
    done.push(`${day}/${stream}`);
  }
  return done;
}

