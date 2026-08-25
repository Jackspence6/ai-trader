"use client";

/**
 * Promotional hedging — the value of a bonus, and what it takes to start.
 *
 * Two questions, and they have very different answers. "What is this bonus
 * worth?" is a margin calculation. "What do I have to put up?" is a capital
 * question, and the naive answer is wrong by an order of magnitude: a 5x
 * rollover on a R2,000 bonus is R10,000 of qualifying bets but nothing like
 * R10,000 of money, because each hedged pair returns almost all of its outlay
 * when it settles and funds the next one.
 */

import { useMemo, useState } from "react";
import { Panel, Micro, Stat, Tag, cx } from "@/components/ui";
import {
  RESEARCHED_PROMOS,
  evaluatePromo,
  planHedge,
  pairOverround,
  IMPLAUSIBLE_OVERROUND,
} from "@/lib/events/promos";
import { planFromCapital, daysToClear } from "@/lib/events/bankroll";
import { zar, pct } from "@/lib/events/format";

function Field({
  label,
  value,
  onChange,
  step = 0.01,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <Micro className="text-dim">{label}</Micro>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          className="tnum w-full border border-line-bright bg-panel-2 px-2 py-1.5 text-right text-[12px] text-ink outline-none focus:border-accent/60"
        />
        {suffix && <span className="micro text-dim">{suffix}</span>}
      </span>
    </label>
  );
}

const LADDER = [1000, 2000, 5000, 10000, 20000, 45000];

export default function PromotionsPage() {
  const [backOdds, setBackOdds] = useState(1.9);
  const [hedgeOdds, setHedgeOdds] = useState(1.947);
  const [capital, setCapital] = useState(2000);
  const [perDay, setPerDay] = useState(4);

  const overround = useMemo(() => pairOverround(backOdds, hedgeOdds), [backOdds, hedgeOdds]);
  const implausible = overround > IMPLAUSIBLE_OVERROUND;
  const valid = backOdds > 1 && hedgeOdds > 1;

  const cycle = useMemo(
    () => (valid ? planHedge(backOdds, hedgeOdds, 1000) : null),
    [valid, backOdds, hedgeOdds],
  );

  // The deposit-match promo is the one whose size the operator controls, so it
  // is the one the capital planner works on. A fixed bonus does not scale.
  const matchPromo = useMemo(
    () => RESEARCHED_PROMOS.find((p) => (p.depositRequiredZar ?? 0) > 0) ?? RESEARCHED_PROMOS[0],
    [],
  );

  const plan = useMemo(() => {
    if (!valid || capital <= 0) return null;
    try {
      return planFromCapital(matchPromo, backOdds, hedgeOdds, { capitalZar: capital });
    } catch {
      return null;
    }
  }, [matchPromo, backOdds, hedgeOdds, capital, valid]);

  const ladder = useMemo(() => {
    if (!valid) return [];
    return LADDER.map((c) => {
      try {
        return { capital: c, plan: planFromCapital(matchPromo, backOdds, hedgeOdds, { capitalZar: c }) };
      } catch {
        return { capital: c, plan: null };
      }
    });
  }, [matchPromo, backOdds, hedgeOdds, valid]);

  const ranked = useMemo(() => {
    if (!valid) return [];
    return RESEARCHED_PROMOS.map((p) => ({
      promo: p,
      ev: evaluatePromo(p, backOdds, hedgeOdds, 5000),
    })).sort((a, b) => b.ev.expectedValueZar - a.ev.expectedValueZar);
  }, [valid, backOdds, hedgeOdds]);

  const totalEv = ranked.filter((r) => r.ev.viable).reduce((a, r) => a + r.ev.expectedValueZar, 0);

  return (
    <div className="space-y-3">
      <Panel label="Hedge quality" hint="the cost of clearing a rollover">
        <p className="mb-3 max-w-3xl text-[12px] leading-relaxed text-muted">
          Every qualifying bet is placed at one book and hedged on the opposite outcome
          at another, so the match result does not matter. What it costs is set by how
          far apart the two books are. A 5× rollover survives a 20% loss rate; a real
          pair costs a few percent — that headroom is the whole edge.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="BACK ODDS (BOOK)" value={backOdds} onChange={setBackOdds} />
          <Field label="HEDGE ODDS (OPPOSITE)" value={hedgeOdds} onChange={setHedgeOdds} />
          <Stat label="Two-book overround" sub={<span className="micro text-dim">the gap you pay</span>}>
            <span className="tnum text-ink">{pct((overround - 1) * 100)}</span>
          </Stat>
          <Stat label="Cost per turnover" sub={<span className="micro text-dim">of each back stake</span>}>
            <span
              className={cx(
                "tnum",
                cycle && cycle.lossRate < 0
                  ? "text-up"
                  : cycle && cycle.lossRate > 0.1
                    ? "text-down"
                    : "text-ink",
              )}
            >
              {cycle ? pct(cycle.lossRate * 100) : "—"}
            </span>
          </Stat>
        </div>

        {implausible && (
          <p className="mt-3 border border-warn/40 bg-warn/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-warn">
            These two prices imply a {Math.round((overround - 1) * 100)}% overround, which
            is not a real complement pair. The hedge must be the <b>opposite</b> outcome:
            backing at {backOdds.toFixed(2)} means hedging near{" "}
            {(1 / (1 - 1 / backOdds)).toFixed(2)}, not {hedgeOdds.toFixed(2)}.
          </p>
        )}
      </Panel>

      <Panel
        label="Starting capital"
        hint={`${matchPromo.name} — the one whose size you control`}
        right={
          plan && (
            <Tag tone={plan.expectedValueZar > 0 ? "up" : "down"}>
              {zar(plan.expectedValueZar)} EV
            </Tag>
          )
        }
      >
        <p className="mb-3 max-w-3xl text-[12px] leading-relaxed text-muted">
          Turnover is not capital. And a 100% match pays R2,000 of bonus on a R2,000
          deposit — so this scales down, and the deposit is withdrawn at the end
          alongside the bonus. Below the bonus cap the binding constraint is how many
          bets you are willing to place by hand, not money.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="TOTAL CAPITAL" value={capital} onChange={setCapital} step={500} suffix="ZAR" />
          <Field label="PAIRS PER DAY" value={perDay} onChange={setPerDay} step={1} />
          {plan && (
            <>
              <Stat label="Return on capital">
                <span className="tnum text-ink">{plan.returnOnCapitalPct.toFixed(0)}%</span>
              </Stat>
              <Stat label="Time to clear">
                <span className="tnum text-ink">
                  {perDay > 0 ? `${Math.ceil(daysToClear(plan, perDay))} days` : "—"}
                </span>
              </Stat>
            </>
          )}
        </div>

        {plan && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Deposit" sub={<span className="micro text-dim">at {matchPromo.venueId}</span>}>
                <span className="tnum text-ink">{zar(plan.depositZar)}</span>
              </Stat>
              <Stat label="Bonus unlocked">
                <span className="tnum text-up">{zar(plan.bonusZar)}</span>
              </Stat>
              <Stat
                label="Hedge float"
                sub={<span className="micro text-dim">survives {plan.bufferCycles} straight losses</span>}
              >
                <span className="tnum text-ink">{zar(plan.hedgeBook.floatZar)}</span>
              </Stat>
              <Stat label="Turnover">
                <span className="tnum text-muted">{zar(plan.turnoverZar)}</span>
              </Stat>
              <Stat label="Cycles" sub={<span className="micro text-dim">at {zar(plan.cycleStakeZar)}</span>}>
                <span className="tnum text-muted">{plan.cycles}</span>
              </Stat>
              <Stat label="Actually at risk" sub={<span className="micro text-dim">the hedging cost</span>}>
                <span className="tnum text-warn">{zar(plan.capitalAtRiskZar)}</span>
              </Stat>
            </div>

            <p className="mt-3 border border-line-bright bg-panel-2 px-3 py-2 text-[11.5px] leading-relaxed text-muted">
              Put in <b className="tnum text-ink">{zar(plan.totalCapitalZar)}</b>, walk out
              with <b className="tnum text-up">{zar(plan.cashOutZar)}</b> — your own money
              back plus the bonus, less <span className="tnum">{zar(plan.hedgingCostZar)}</span>{" "}
              of hedging cost. Once, per person, per bookmaker.
              {capital - plan.totalCapitalZar > 1 && (
                <span className="text-dim">
                  {" "}
                  {zar(capital - plan.totalCapitalZar)} of your {zar(capital)} stays in your
                  pocket: a bigger deposit means more turnover, and more turnover means
                  more cycles than the planner will ask of you.
                </span>
              )}
            </p>

            {plan.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-line pt-2">
                {plan.warnings.map((w, i) => (
                  <li key={i} className="text-[11px] leading-relaxed text-warn">
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {ladder.length > 0 && (
          <div className="mt-4 overflow-x-auto border-t border-line pt-3">
            <table className="w-full min-w-[600px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-line">
                  {["Capital", "Deposit", "Hedge float", "Stake", "Cycles", "Cost", "EV", "ROC"].map((h) => (
                    <th key={h} className="px-2 py-1.5 font-normal">
                      <Micro className="text-dim">{h.toUpperCase()}</Micro>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ladder.map(({ capital: c, plan: p }) => (
                  <tr
                    key={c}
                    className={cx(
                      "tnum border-b border-line/60",
                      c === capital ? "text-ink" : "text-muted",
                    )}
                  >
                    <td className="px-2 py-1.5">{zar(c)}</td>
                    <td className="px-2 py-1.5">{p ? zar(p.depositZar) : "—"}</td>
                    <td className="px-2 py-1.5">{p ? zar(p.hedgeBook.floatZar) : "—"}</td>
                    <td className="px-2 py-1.5">{p ? zar(p.cycleStakeZar) : "—"}</td>
                    <td className="px-2 py-1.5">{p ? p.cycles : "—"}</td>
                    <td className="px-2 py-1.5 text-warn">{p ? zar(p.hedgingCostZar) : "—"}</td>
                    <td className="px-2 py-1.5 text-up">{p ? zar(p.expectedValueZar) : "—"}</td>
                    <td className="px-2 py-1.5">{p ? `${p.returnOnCapitalPct.toFixed(0)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-relaxed text-dim">
              Expected value is close to linear in what you put up until the match hits
              its cap, which is what makes starting small a real option rather than a
              compromise. Extra capital below the cap buys speed, not a better rate.
            </p>
          </div>
        )}
      </Panel>

      <Panel
        label="Researched offers"
        right={totalEv > 0 && <Tag tone="up">{zar(totalEv)} combined</Tag>}
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {ranked.map(({ promo, ev }) => (
            <div key={promo.id} className={cx("border border-line p-3", !ev.viable && "opacity-60")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] text-ink">{promo.name}</div>
                  <div className="mt-0.5 text-[10.5px] leading-snug text-dim">{promo.termsNote}</div>
                </div>
                <span className={cx("tnum shrink-0 text-[15px]", ev.viable ? "text-up" : "text-down")}>
                  {zar(ev.expectedValueZar)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2">
                <Stat label="Bonus">
                  <span className="tnum text-[12px] text-ink">{zar(promo.bonusZar)}</span>
                </Stat>
                <Stat label="Turnover">
                  <span className="tnum text-[12px] text-muted">{zar(ev.requiredTurnoverZar)}</span>
                </Stat>
                <Stat label="Headroom">
                  <span
                    className={cx(
                      "tnum text-[12px]",
                      ev.lossRate < ev.breakEvenLossRate ? "text-up" : "text-down",
                    )}
                  >
                    {pct(ev.lossRate * 100)} / {(ev.breakEvenLossRate * 100).toFixed(0)}%
                  </span>
                </Stat>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          These terms come from research, not from an account, and{" "}
          <b className="text-muted">must be re-verified</b> before any money moves — only
          the WSB deposit match is explicit in its own offer name, and assuming a match
          where there is none overstates a small plan several times over. One bonus per
          person, household and IP: this desk plans a single genuine account per book and
          will not help with anything else.
        </p>
      </Panel>
    </div>
  );
}
