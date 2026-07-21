"use client";

/**
 * Risk — the kill switch, active limits, and halt history.
 *
 * Resuming requires a typed reason. That is not friction for its own sake:
 * halting is cheap and reversible, resuming is the direction that can lose
 * money, and the audit log is where the next person finds out why it was
 * thought safe to restart.
 */

import { useCallback, useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import type { HaltEvent, HaltState, SweepResult } from "@/lib/killswitch";
import type { EngineConfig } from "@/lib/engine/config";
import { computePortfolio } from "@/lib/portfolio/sleeves";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

type HaltResponse = { state: HaltState; audit: HaltEvent[] };

export default function RiskPage() {
  const halt = useLive<HaltResponse>("/api/halt", 10_000);
  const cfg = useLive<{ config: EngineConfig }>("/api/config", 30_000);

  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = halt.data?.state;
  const config = cfg.data?.config;
  const portfolio = computePortfolio(config?.navUsd ?? 0, config?.sleeves ?? []);

  const refresh = useCallback(() => halt.refresh(), [halt]);

  async function send(action: "halt" | "resume") {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/halt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() }),
      });
      const d = (await r.json()) as { error?: string; sweep?: SweepResult };
      if (d.error) setError(d.error);
      else {
        setSweep(d.sweep ?? null);
        setReason("");
      }
      refresh();
    } catch {
      setError("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 p-3">
      {/* ----------------------------------------------------- kill switch */}
      <Panel
        label="KILL SWITCH"
        hint="HALT STATE FIRST, THEN CANCEL AT EVERY VENUE"
        right={
          state ? (
            <Tag tone={state.halted ? "down" : "up"}>
              {state.halted ? "HALTED" : "RUNNING"}
            </Tag>
          ) : null
        }
      >
        {state?.halted ? (
          <div className="space-y-3">
            <div className="border border-down/35 bg-down/5 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <StatusDot state="bad" />
                <span className="text-[13px] text-ink">Trading is halted</span>
              </div>
              <dl className="mt-2.5 space-y-1.5 text-[11.5px]">
                <Row
                  k="Since"
                  v={
                    state.since
                      ? new Date(state.since).toISOString().replace("T", " ").slice(0, 19) +
                        " UTC"
                      : "—"
                  }
                />
                <Row k="Reason" v={state.reason ?? "—"} />
                <Row
                  k="Source"
                  v={`${state.source ?? "—"}${state.actor ? ` (${state.actor})` : ""}`}
                />
              </dl>
            </div>

            <div>
              <Micro className="mb-1.5">WHY IS IT SAFE TO RESUME?</Micro>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Required — recorded in the audit log"
                className="w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
              />
              <button
                onClick={() => send("resume")}
                disabled={busy || !reason.trim()}
                className="micro mt-2 w-full border border-up/50 bg-up/10 py-2 text-up transition-colors hover:bg-up/20 disabled:opacity-40"
              >
                {busy ? "RESUMING…" : "RESUME TRADING"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <StatusDot state="ok" pulse />
              <span className="text-[13px] text-muted">Running. Nothing is halted.</span>
            </div>
            <div>
              <Micro className="mb-1.5">REASON (OPTIONAL)</Micro>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. investigating a reconciliation mismatch"
                className="w-full border border-line-bright bg-raised/60 px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent/50"
              />
              <button
                onClick={() => send("halt")}
                disabled={busy}
                className="micro mt-2 w-full border border-down/50 bg-down/10 py-2 text-down transition-colors hover:bg-down/20 disabled:opacity-40"
              >
                {busy ? "HALTING…" : "HALT ALL TRADING"}
              </button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-[11px] text-down">{error}</p>}

        {sweep && (
          <div className="mt-3 border-t border-line pt-3">
            <Micro className="mb-2">LAST VENUE SWEEP</Micro>
            {sweep.noCredentials ? (
              <p className="text-[11px] text-dim">
                No enabled credentials — nothing to cancel. The halt still applies.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {sweep.venues.map((v) => (
                  <li key={v.credentialId} className="flex items-start gap-2 text-[11.5px]">
                    <StatusDot state={v.ok ? "ok" : "bad"} />
                    <span className="text-ink">{v.venue}</span>
                    <span className="text-dim">{v.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          Halt state is written before any venue call. If the sweep hangs or the
          process dies mid-sweep, everything that consults halt state already
          refuses to trade — the reverse order leaves a window where orders are
          being cancelled while strategies are still free to place new ones.
        </p>
      </Panel>

      {/* -------------------------------------------------------- redundancy */}
      <Panel label="OTHER WAYS TO STOP" hint="THIS PAGE NEEDS A WORKING DASHBOARD">
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
          <div>
            <Micro className="mb-1.5">COMMAND LINE</Micro>
            <code className="block border border-line-bright bg-raised/40 px-2 py-1.5 text-[11px] text-muted">
              pnpm halt &quot;reason&quot;
            </code>
            <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
              Needs only a shell on the box. Works when the dashboard is
              rebuilding, crashed, or wedged.
            </p>
          </div>
          <div>
            <Micro className="mb-1.5">STANDALONE ENDPOINT</Micro>
            <code className="block border border-line-bright bg-raised/40 px-2 py-1.5 text-[11px] text-muted">
              curl -X POST localhost:3999/halt -d &apos;reason=why&apos;
            </code>
            <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
              Separate process, separate port, loopback only. Start it with{" "}
              <code className="text-muted">pnpm halt:server</code>.
            </p>
          </div>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          Three paths is not redundancy for its own sake: the dashboard needs a
          browser, the endpoint needs its own process alive, and the CLI needs a
          shell. The failure that takes out one rarely takes out all three.
        </p>
      </Panel>

      {/* ------------------------------------------------------------ limits */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1fr]">
        <Panel label="ACTIVE LIMITS" hint="FROM THE CURRENT CONFIGURATION">
          {config ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <Stat
                label="DAILY LOSS LIMIT"
                sub={<span className="text-dim">halts everything</span>}
              >
                <span className="tnum text-[15px]">
                  {(config.dailyLossLimitPct * 100).toFixed(1)}%
                </span>
              </Stat>
              <Stat
                label="MAX DRAWDOWN"
                sub={<span className="text-dim">from high-water mark</span>}
              >
                <span className="tnum text-[15px]">
                  {(config.maxDrawdownPct * 100).toFixed(1)}%
                </span>
              </Stat>
              <Stat label="LEVERAGE CAP" sub={<span className="text-dim">hard ceiling</span>}>
                <span className="tnum text-[15px]">{config.maxLeverage}x</span>
              </Stat>
              <Stat label="MAX DATA AGE" sub={<span className="text-dim">staleness veto</span>}>
                <span className="tnum text-[15px]">{config.maxDataAgeSeconds}s</span>
              </Stat>
            </div>
          ) : (
            <p className="text-[11px] text-dim">Loading…</p>
          )}
          <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
            These are enforced by the risk gate on every intent. Tripping
            automatically on breach needs position and PnL accounting, which does
            not exist yet — today they bound sizing rather than firing on their
            own.
          </p>
        </Panel>

        <Panel label="SLEEVE ISOLATION" hint="EACH FAILS INDEPENDENTLY" flush>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>SLEEVE</Th>
                  <Th right>DAILY LOSS</Th>
                  <Th right>DRAWDOWN</Th>
                  <Th right>STATE</Th>
                </tr>
              </thead>
              <tbody>
                {portfolio.sleeves.map((s) => (
                  <tr key={s.def.id} className="border-b border-line/60">
                    <Td>
                      <span className="text-ink">{s.def.name}</span>
                    </Td>
                    <Td right>
                      <Money usd={s.dailyLossLimitUsd} dp={0} />
                    </Td>
                    <Td right>
                      <Money usd={s.drawdownLimitUsd} dp={0} />
                    </Td>
                    <Td right>
                      <span
                        className={cx(
                          "micro",
                          s.allocation.halted ? "text-down" : "text-dim",
                        )}
                      >
                        {s.allocation.halted ? "HALTED" : s.tradable ? "READY" : "INACTIVE"}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            A sleeve breaching its own limit halts that sleeve alone — the
            market-neutral book keeps earning while a directional one sits in
            timeout. Enforcing that automatically needs per-sleeve PnL, which
            arrives with position accounting.
          </p>
        </Panel>
      </div>

      {/* ------------------------------------------------------------ history */}
      <Panel label="HALT HISTORY" hint="EVERY TRANSITION, WHO AND WHY" flush>
        {!halt.data || halt.data.audit.length === 0 ? (
          <div className="p-4 text-[12px] text-dim">
            No halts recorded. Every halt and resume is logged here with its
            source, actor and reason.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  <Th>WHEN</Th>
                  <Th>ACTION</Th>
                  <Th>SOURCE</Th>
                  <Th>ACTOR</Th>
                  <Th>REASON</Th>
                </tr>
              </thead>
              <tbody>
                {halt.data.audit.map((e, i) => (
                  <tr key={`${e.ts}-${i}`} className="border-b border-line/60">
                    <Td>
                      <span className="tnum text-dim">
                        {new Date(e.ts).toISOString().replace("T", " ").slice(0, 19)}
                      </span>
                    </Td>
                    <Td>
                      <span className={e.action === "halt" ? "text-down" : "text-up"}>
                        {e.action.toUpperCase()}
                      </span>
                    </Td>
                    <Td>{e.source}</Td>
                    <Td>{e.actor ?? "—"}</Td>
                    <Td>
                      <span className="text-dim">{e.reason ?? "—"}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-dim">{k}</dt>
      <dd className="text-muted">{v}</dd>
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

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={cx("px-3 py-2 text-muted", right ? "text-right" : "text-left")}>
      {children}
    </td>
  );
}
