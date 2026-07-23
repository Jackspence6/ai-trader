"use client";

/**
 * System — is the machinery actually running?
 *
 * The recorder is the only always-on component that exists today, and it is the
 * one whose silent failure costs the most: evidence not captured cannot be
 * captured later. So this screen leads with its liveness, derives that from a
 * PID check rather than a file timestamp, and shows gaps in the recorded span
 * explicitly rather than quietly omitting empty days.
 */

import { useLive } from "@/lib/live";
import type { LivenessState } from "@/lib/recorder/heartbeat";
import type { RecordingSummary } from "@/lib/recorder/store";
import type { LoopHealth } from "@/lib/engine/health";
import { cx, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type RecordingsResponse = {
  root: string;
  summary: RecordingSummary;
  liveness: LivenessState;
  stateBackend: string;
};

type EngineResponse = {
  health: LoopHealth;
  recent: {
    ts: number;
    scored: number;
    executed: number;
    closed: number;
    openPositions: number;
    navAfter: number;
    rejections: Record<string, number>;
    exits: Record<string, number>;
    skipped: string | null;
  }[];
};

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function duration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Every UTC day between two keys, inclusive — so gaps stay visible. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to + "T00:00:00Z");
  let t = Date.parse(from + "T00:00:00Z");
  while (t <= end && out.length < 400) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

export default function SystemPage() {
  const { data, status, ageSeconds } = useLive<RecordingsResponse>(
    "/api/recordings",
    20_000,
  );
  const engine = useLive<EngineResponse>("/api/engine", 30_000);

  const live = data?.liveness;
  const sum = data?.summary;

  return (
    <div className="space-y-3 p-3">
      <LoopBanner health={engine.data?.health} />
      <RecorderBanner liveness={live} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Panel>
          <Stat label="DAYS RECORDED" sub={<span className="text-dim">with data</span>}>
            <span className="tnum text-[19px] text-ink">{sum?.days ?? 0}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="ROWS" sub={<span className="text-dim">last 14 days</span>}>
            <span className="tnum text-[19px] text-ink">
              {(sum?.totalLines ?? 0).toLocaleString("en-US")}
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="ON DISK" sub={<span className="text-dim">last 14 days</span>}>
            <span className="tnum text-[19px] text-muted">{bytes(sum?.totalBytes ?? 0)}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="FIRST DAY" sub={<span className="text-dim">UTC</span>}>
            <span className="tnum text-[15px] text-muted">{sum?.firstDay ?? "—"}</span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="FEED" sub={<span className="text-dim">this page</span>}>
            <span className="flex items-center gap-2 text-[15px]">
              <StatusDot
                state={status === "live" ? "ok" : status === "error" ? "bad" : "idle"}
                pulse={status === "live"}
              />
              <span className="tnum text-dim">{ageSeconds}s</span>
            </span>
          </Stat>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.3fr_1fr]">
        <Panel label="RECORDED DAYS" hint="GAPS SHOWN EXPLICITLY" flush>
          <DayTable summary={sum} />
        </Panel>

        <div className="space-y-3">
          <Panel label="TRADING LOOP" hint="DERIVED FROM THE PASS LOG" flush>
            <LoopDetail engine={engine.data} />
          </Panel>

          <Panel label="RECORDER PROCESS" hint="LIVENESS FROM PID CHECK">
            <ProcessDetail liveness={live} />
          </Panel>

          <Panel label="STORAGE" hint="APPEND-ONLY EVENT LOG">
            <dl className="space-y-2.5 text-[12px]">
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Path</dt>
                <dd className="truncate text-muted" title={data?.root}>
                  {data?.root ? "…" + data.root.slice(-38) : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Format</dt>
                <dd className="text-muted">JSONL, gzipped after the day closes</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-dim">Streams</dt>
                <dd className="text-muted">quotes · funding · scan · nav</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-dim">App state</dt>
                <dd className="truncate text-muted" title={data?.stateBackend}>
                  {data?.stateBackend ?? "—"}
                </dd>
              </div>
            </dl>
            <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
              Append-only and never rewritten, so a crash loses at most the last
              line and the reader skips it. Importing into TimescaleDB later is a
              straight replay of each line, in order.
            </p>
          </Panel>
        </div>
      </div>

      <Panel label="NOT YET RUNNING" hint="THE BRIDGE TO REAL CAPITAL">
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {[
            "Live venue execution — every order today fills in the paper simulator, priced from real quotes",
            "Balance reconciliation against venue-reported truth (meaningless until real orders exist)",
            "Exchange-side dead-man timers and the venue-level kill switch",
            "Telegram alerting for fills, breaches and halts",
            "Postgres / TimescaleDB in production — state is files on this box today",
            "M2 dated-futures basis capture — scored every pass, held back until settlement is modelled properly",
          ].map((t) => (
            <li key={t} className="flex gap-2.5 text-[12px] text-muted">
              <span className="mt-1.75 size-1 shrink-0 bg-dim" />
              <span className="leading-relaxed">{t}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          Everything else on this screen is live: the recorder, the 5-minute
          trading loop, paper order management, per-sleeve P&amp;L attribution,
          portfolio charter enforcement and the ML prediction ledger. See
          ROADMAP.md for sequencing of the rest.
        </p>
      </Panel>
    </div>
  );
}

function LoopBanner({ health }: { health?: LoopHealth }) {
  if (!health) {
    return (
      <div className="flex items-center gap-2 border border-line-bright bg-raised/30 px-3 py-2.5">
        <StatusDot state="idle" />
        <span className="text-[12px] text-dim">Checking trading loop…</span>
      </div>
    );
  }

  if (!health.everRan || health.state === "stopped") {
    return (
      <div className="flex flex-wrap items-center gap-2 border border-down/30 bg-down/5 px-3 py-2.5">
        <Tag tone="down">{health.everRan ? "LOOP STOPPED" : "LOOP NEVER RAN"}</Tag>
        <span className="text-[12px] text-muted">
          {health.everRan
            ? `No pass in ${duration((health.lastPassAgeSeconds ?? 0) * 1000)} against a ${Math.round(
                (health.medianIntervalSeconds ?? 0) / 60,
              )}m cadence. No trading decisions are being made.`
            : "No trading pass has ever been recorded."}
        </span>
        <code className="micro ml-auto border border-line-bright px-1.5 py-1 text-dim">
          pnpm trade
        </code>
      </div>
    );
  }

  // A running loop that scores nothing pass after pass is blind, not healthy —
  // every venue fetch failing looks exactly like this.
  if (health.zeroScoredStreak >= 3) {
    return (
      <div className="flex flex-wrap items-center gap-2 border border-warn/30 bg-warn/5 px-3 py-2.5">
        <Tag tone="warn">LOOP BLIND</Tag>
        <span className="text-[12px] text-muted">
          {health.zeroScoredStreak} consecutive passes scored zero opportunities —
          check venue connectivity.
        </span>
      </div>
    );
  }

  const tone = health.state === "running" ? "up" : "warn";
  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-2 border px-3 py-2.5",
        tone === "up" ? "border-up/25 bg-up/5" : "border-warn/30 bg-warn/5",
      )}
    >
      <Tag tone={tone}>{health.state === "running" ? "LOOP RUNNING" : "LOOP LATE"}</Tag>
      <span className="text-[12px] text-muted">
        last pass {Math.round(health.lastPassAgeSeconds ?? 0)}s ago
        {health.medianIntervalSeconds &&
          ` · cadence ~${Math.round(health.medianIntervalSeconds / 60)}m`}
        {` · window: ${health.executed} entered, ${health.closed} closed over ${health.passes} passes`}
        {health.lastSkipped && ` · last pass skipped: ${health.lastSkipped}`}
      </span>
    </div>
  );
}

function LoopDetail({ engine }: { engine: EngineResponse | null }) {
  if (!engine || engine.recent.length === 0) {
    return (
      <p className="p-3 text-[11px] leading-relaxed text-dim">
        No passes recorded yet. The loop runs via{" "}
        <code className="text-muted">pnpm trade</code> on any box that stays up,
        or the deployment cron.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line">
            <Th>PASS</Th>
            <Th right>SCORED</Th>
            <Th right>IN</Th>
            <Th right>OUT</Th>
            <Th right>OPEN</Th>
            <Th right>NAV</Th>
          </tr>
        </thead>
        <tbody>
          {engine.recent.slice(0, 10).map((r) => (
            <tr key={r.ts} className="border-b border-line/60 hover:bg-raised/40">
              <Td>
                <span
                  className="tnum text-muted"
                  title={r.skipped ?? Object.entries(r.rejections)
                    .map(([k, n]) => `${k}: ${n}`)
                    .join(" · ")}
                >
                  {new Date(r.ts).toISOString().slice(11, 19)}
                </span>
              </Td>
              <Td right>
                <span className={cx("tnum", r.scored === 0 && !r.skipped ? "text-warn" : "")}>
                  {r.scored}
                </span>
              </Td>
              <Td right>
                <span className={cx("tnum", r.executed > 0 ? "text-up" : "text-dim")}>
                  {r.executed}
                </span>
              </Td>
              <Td right>
                <span className={cx("tnum", r.closed > 0 ? "text-warn" : "text-dim")}>
                  {r.closed}
                </span>
              </Td>
              <Td right>
                <span className="tnum">{r.openPositions}</span>
              </Td>
              <Td right>
                <span className="tnum">{r.navAfter.toFixed(2)}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
        Hover a pass for its rejection breakdown. UTC times. The loop process
        loads code once at start — restart it after deploying engine changes.
      </p>
    </div>
  );
}

function RecorderBanner({ liveness }: { liveness?: LivenessState }) {
  if (!liveness) {
    return (
      <div className="flex items-center gap-2 border border-line-bright bg-raised/30 px-3 py-2.5">
        <StatusDot state="idle" />
        <span className="text-[12px] text-dim">Checking recorder…</span>
      </div>
    );
  }

  if (liveness.state === "running") {
    return (
      <div className="flex flex-wrap items-center gap-2 border border-up/25 bg-up/5 px-3 py-2.5">
        <Tag tone="up">RECORDING</Tag>
        <span className="text-[12px] text-muted">
          pid {liveness.heartbeat.pid} · up{" "}
          {duration(liveness.heartbeat.beatAt - liveness.heartbeat.startedAt)} ·
          last beat {liveness.ageSeconds}s ago · {liveness.heartbeat.errors} errors
        </span>
      </div>
    );
  }

  if (liveness.state === "stale") {
    return (
      <div className="flex flex-wrap items-center gap-2 border border-down/30 bg-down/5 px-3 py-2.5">
        <Tag tone="down">STALE</Tag>
        <span className="text-[12px] text-muted">{liveness.reason}</span>
        <code className="micro ml-auto border border-line-bright px-1.5 py-1 text-dim">
          pnpm record
        </code>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border border-warn/30 bg-warn/5 px-3 py-2.5">
      <Tag tone="warn">NOT RUNNING</Tag>
      <span className="text-[12px] text-muted">
        No data is being captured. Every day the recorder is off is evidence that
        cannot be recovered later.
      </span>
      <code className="micro ml-auto border border-line-bright px-1.5 py-1 text-dim">
        pnpm record
      </code>
    </div>
  );
}

function ProcessDetail({ liveness }: { liveness?: LivenessState }) {
  if (!liveness || liveness.state === "stopped") {
    return (
      <p className="text-[11px] leading-relaxed text-dim">
        The recorder is a standalone process, deliberately separate from the
        dashboard so that closing the browser or restarting the dev server does
        not interrupt capture. Start it from the dashboard directory with{" "}
        <code className="text-muted">pnpm record</code>.
      </p>
    );
  }

  const hb = liveness.heartbeat;
  const rows: [string, string][] = [
    ["PID", String(hb.pid)],
    // Measured to the last heartbeat, not to now — the process may have died
    // since, and claiming live uptime for a dead recorder is the exact error
    // this screen exists to prevent.
    ["Uptime at last beat", duration(hb.beatAt - hb.startedAt)],
    ["Last beat", `${liveness.ageSeconds}s ago`],
    ["Quote cycles", String(hb.cycles.quotes)],
    ["Scan cycles", String(hb.cycles.scan)],
    ["Funding cycles", String(hb.cycles.funding)],
    ["Rows written", String(hb.rows.quotes + hb.rows.scan + hb.rows.funding)],
    ["Errors", String(hb.errors)],
  ];

  return (
    <>
      <dl className="space-y-2 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-dim">{k}</dt>
            <dd className="tnum text-muted">{v}</dd>
          </div>
        ))}
      </dl>
      {hb.lastError && (
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-down">
          Last error — {hb.lastError}
        </p>
      )}
    </>
  );
}

function DayTable({ summary }: { summary?: RecordingSummary }) {
  if (!summary || summary.perDay.length === 0) {
    return (
      <div className="p-4 text-[12px] text-dim">
        Nothing recorded yet. Run <code className="text-muted">pnpm record</code> in
        the dashboard directory.
      </div>
    );
  }

  const present = new Map(summary.perDay.map((d) => [d.day, d]));
  const span = summary.lastDay
    ? daysBetween(summary.perDay[0].day, summary.lastDay)
    : summary.perDay.map((d) => d.day);

  const lineFor = (day: string, stream: string) =>
    present.get(day)?.streams.find((s) => s.stream === stream)?.lines ?? 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line">
            <Th>DAY</Th>
            <Th right>QUOTES</Th>
            <Th right>SCAN</Th>
            <Th right>FUNDING</Th>
            <Th right>SIZE</Th>
            <Th right>STATE</Th>
          </tr>
        </thead>
        <tbody>
          {span.map((day) => {
            const d = present.get(day);
            if (!d) {
              return (
                <tr key={day} className="border-b border-line/60">
                  <Td>
                    <span className="text-dim">{day}</span>
                  </Td>
                  <Td right colSpan={4}>
                    <span className="text-warn">no data recorded</span>
                  </Td>
                  <Td right>
                    <span className="micro text-warn">GAP</span>
                  </Td>
                </tr>
              );
            }
            const compressed = d.streams.some((s) => s.compressed);
            return (
              <tr key={day} className="border-b border-line/60 hover:bg-raised/40">
                <Td>
                  <span className="text-ink">{day}</span>
                </Td>
                <Td right>
                  <span className="tnum">{lineFor(day, "quotes").toLocaleString("en-US")}</span>
                </Td>
                <Td right>
                  <span className="tnum">{lineFor(day, "scan").toLocaleString("en-US")}</span>
                </Td>
                <Td right>
                  <span className="tnum">{lineFor(day, "funding").toLocaleString("en-US")}</span>
                </Td>
                <Td right>
                  <span className="tnum">{bytes(d.totalBytes)}</span>
                </Td>
                <Td right>
                  <span className={cx("micro", compressed ? "text-dim" : "text-muted")}>
                    {compressed ? "GZIP" : "OPEN"}
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
        Only the last 14 days are tallied here — counting lines means reading
        every byte, which is not something to do on every dashboard poll. Run{" "}
        <code className="text-muted">pnpm record:stats</code> for the full history.
      </p>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cx(
        "micro whitespace-nowrap px-3 py-2 font-normal text-dim",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  colSpan,
}: {
  children: React.ReactNode;
  right?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "whitespace-nowrap px-3 py-2 text-muted",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </td>
  );
}
