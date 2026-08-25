"use client";

/**
 * The stake plan for one opportunity.
 *
 * A margin percentage is not actionable; "put R3,420 on this and R6,580 on that,
 * and you are up R91 whichever way it goes" is. This panel does that conversion
 * and shows the two numbers that decide whether to bother: what the worst branch
 * pays, and how long the window has been open.
 *
 * Stakes are rounded to R10. That is not cosmetic — an exact stake of R3,417.62
 * is a fingerprint, and a desk placing eight of those a day is a desk announcing
 * itself. Rounding costs a little of the edge and the panel shows what it cost,
 * because a rounding that quietly turns a 0.4% margin negative is worth knowing
 * about before the second leg goes on.
 */

import { useEffect, useMemo, useState } from "react";
import { Panel, Micro, Stat, cx } from "@/components/ui";
import { apiPost } from "@/lib/events/api";
import {
  durationShort,
  marketLabel,
  odds as fmtOdds,
  pct,
  sastTime,
  zar,
} from "@/lib/events/format";
import type { Opportunity } from "@/lib/events/types";
import { RuleRiskBadge, ScoreBadge, TypeBadge, UrgencyBadge } from "./badges";

const BREAKDOWN_LABELS: Record<string, string> = {
  margin: "Margin",
  executable_size: "Executable size",
  window_duration: "Window duration",
  venue_softness: "Venue softness",
  rule_risk: "Rule risk",
  account_safety: "Account safety",
  fx_risk: "FX risk",
  resolution_risk: "Resolution risk",
};

/** Balanced stakes, then naturalised to R10 steps and re-checked at the worst branch. */
function computeStakes(legs: Opportunity["legs"], total: number) {
  const qs = legs.map((l) => 1 / l.odds);
  const S = qs.reduce((a, b) => a + b, 0);
  const exact = qs.map((q) => (total * q) / S);
  const rounded = exact.map((s) => Math.max(10, Math.round(s / 10) * 10));
  const totalRounded = rounded.reduce((a, b) => a + b, 0);
  const worst = Math.min(...rounded.map((s, i) => s * legs[i].odds)) - totalRounded;
  return { exact, rounded, totalRounded, worst, marginPct: (1 - S) * 100 };
}

export function StakePlan({
  opp,
  onClose,
}: {
  opp: Opportunity | null;
  onClose: () => void;
}) {
  const [total, setTotal] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // A new opportunity gets its own sizing, not the last one's.
  useEffect(() => {
    setTotal(null);
    setFeedback(null);
  }, [opp?.id]);

  const T = total ?? opp?.total_stake_zar ?? 10000;
  const calc = useMemo(() => (opp ? computeStakes(opp.legs, T) : null), [opp, T]);

  async function sendFeedback(status: string) {
    if (!opp) return;
    setFeedback(status);
    await apiPost("/api/events/feedback", { opportunity_id: opp.id, status }, "/feedback");
  }

  if (!opp || !calc) return null;

  const roundingCost = opp.guaranteed_profit_zar - calc.worst;

  return (
    <Panel
      label="Stake plan"
      hint={opp.event_label}
      right={
        <button onClick={onClose} className="micro text-dim transition-colors hover:text-ink">
          CLOSE
        </button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <ScoreBadge score={opp.score} />
        <TypeBadge type={opp.opp_type} />
        <UrgencyBadge urgency={opp.urgency} />
        <RuleRiskBadge opp={opp} />
        <span className="micro text-dim">
          {marketLabel(opp.market_key)} · {sastTime(opp.start_time)}
        </span>
      </div>

      {opp.rule_risk && opp.rule_risk_note && (
        <p className="mb-3 border border-warn/35 bg-warn/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-warn">
          {opp.rule_risk_note}
        </p>
      )}

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Margin">
          <span className="tnum text-up">{pct(opp.margin_pct)}</span>
        </Stat>
        <Stat label="Worst branch" sub={<span className="micro text-dim">after R10 rounding</span>}>
          <span className={cx("tnum", calc.worst > 0 ? "text-up" : "text-down")}>
            {zar(calc.worst)}
          </span>
        </Stat>
        <Stat label="Executable / leg">
          <span className="tnum text-muted">{zar(opp.executable_zar_per_leg)}</span>
        </Stat>
        <Stat label="Open for">
          <span className="tnum text-muted">
            {durationShort(
              opp.state === "active"
                ? (Date.now() - new Date(opp.first_seen).getTime()) / 1000
                : opp.window_s,
            )}
          </span>
        </Stat>
      </div>

      <label className="mb-3 flex items-center gap-2">
        <Micro className="text-dim">TOTAL STAKE</Micro>
        <input
          type="number"
          step={500}
          value={T}
          onChange={(e) => setTotal(Number(e.target.value) || 0)}
          className="tnum w-32 border border-line-bright bg-panel-2 px-2 py-1 text-right text-[12px] text-ink outline-none focus:border-accent/60"
        />
        <span className="micro text-dim">ZAR</span>
        {roundingCost > 0.5 && (
          <span className="micro text-dim">
            · rounding costs {zar(roundingCost)}
          </span>
        )}
      </label>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] text-left text-[12px]">
          <thead>
            <tr className="border-b border-line">
              <th className="px-2 py-1.5 font-normal"><Micro className="text-dim">#</Micro></th>
              <th className="px-2 py-1.5 font-normal"><Micro className="text-dim">BOOK</Micro></th>
              <th className="px-2 py-1.5 font-normal"><Micro className="text-dim">SELECTION</Micro></th>
              <th className="px-2 py-1.5 text-right font-normal"><Micro className="text-dim">ODDS</Micro></th>
              <th className="px-2 py-1.5 text-right font-normal"><Micro className="text-dim">STAKE</Micro></th>
              <th className="px-2 py-1.5 text-right font-normal"><Micro className="text-dim">RETURNS</Micro></th>
            </tr>
          </thead>
          <tbody>
            {opp.legs.map((leg, i) => (
              <tr key={i} className="border-b border-line/60">
                <td className="px-2 py-2">
                  <span
                    className="micro text-dim"
                    title="Place in this order — softest book first, deepest last"
                  >
                    {leg.order_index || i + 1}
                  </span>
                </td>
                <td className="px-2 py-2 text-ink">
                  {leg.deep_link ? (
                    <a
                      href={leg.deep_link}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline decoration-line-bright underline-offset-2 hover:text-accent"
                    >
                      {leg.venue_name}
                    </a>
                  ) : (
                    leg.venue_name
                  )}
                </td>
                <td className="px-2 py-2 text-muted">{leg.selection_label || leg.outcome}</td>
                <td className="tnum px-2 py-2 text-right text-ink">{fmtOdds(leg.odds)}</td>
                <td className="tnum px-2 py-2 text-right text-ink">{zar(calc.rounded[i])}</td>
                <td className="tnum px-2 py-2 text-right text-muted">
                  {zar(calc.rounded[i] * leg.odds)}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} className="px-2 py-2 text-right">
                <Micro className="text-dim">TOTAL</Micro>
              </td>
              <td className="tnum px-2 py-2 text-right text-ink">{zar(calc.totalRounded)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      {Object.keys(opp.score_breakdown ?? {}).length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <Micro className="mb-2 block text-dim">SCORE BREAKDOWN</Micro>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            {Object.entries(opp.score_breakdown).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-muted">{BREAKDOWN_LABELS[k] ?? k}</span>
                <span className="tnum text-[11px] text-ink">{v.toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase 1 places nothing automatically at a bookmaker. What the operator
          did is the only way the go/no-go tracker learns whether a scored
          opportunity was actually catchable. */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
        <Micro className="mr-1 text-dim">I</Micro>
        {["placed", "missed", "partial", "voided"].map((s) => (
          <button
            key={s}
            onClick={() => sendFeedback(s)}
            className={cx(
              "micro border px-1.5 py-1 transition-colors",
              feedback === s
                ? "border-accent/50 text-accent"
                : "border-line-bright text-muted hover:text-ink",
            )}
          >
            {s}
          </button>
        ))}
        <span className="micro ml-1 text-dim">
          · feeds the capture-rate measurement on Research
        </span>
      </div>

      {opp.notes?.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-3">
          {opp.notes.map((n, i) => (
            <li key={i} className="text-[11px] text-muted">
              {n}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
