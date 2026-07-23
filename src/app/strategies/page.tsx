"use client";

/**
 * Strategies — the playbook, with each strategy's standing on its face.
 *
 * A card per strategy: what it does in plain English, which portfolio
 * governs it, where it stands on the promotion pipeline (GOVERNANCE.md §3),
 * the evidence that put it there, and its LIVE paper record — P&L split,
 * trades, open positions — joined from the performance report. No demo
 * content: every number on this screen is the real book.
 */

import { useLive } from "@/lib/live";
import { cx, Info, Micro, Panel, Tag } from "@/components/ui";

type StrategyPnl = {
  key: string;
  realisedUsd: number;
  unrealisedUsd: number | null;
  fundingUsd: number;
  feesUsd: number;
  totalUsd: number;
  trades: number;
  openPositions: number;
};

type PerformanceResponse = { report: { byStrategy: StrategyPnl[] } };

type Standing = "funded" | "shadow" | "waiting";

const STRATEGIES: {
  code: string;
  name: string;
  plain: string;
  portfolio: string;
  tone: "accent" | "warn" | "down";
  standing: Standing;
  standingNote: string;
  evidence: string;
  terms: string[];
}[] = [
  {
    code: "L1",
    name: "Crypto funding carry",
    plain:
      "Owns a coin and shorts its perpetual future in equal size, so price moves cancel out. Collects the funding payments shorts receive while the market pays them.",
    portfolio: "Conservative",
    tone: "accent",
    standing: "funded",
    standingNote: "Funded · core allocation",
    evidence:
      "Backtested on 167 days of real funding: breakeven at taker cost, positive with maker entries and the regime exit. The ML model shadow-grades every entry's regime.",
    terms: ["carry", "funding", "delta_neutral"],
  },
  {
    code: "L3",
    name: "Stablecoin peg watch",
    plain:
      "Watches dollar-pegged coins (USDC, FDUSD). If one ever trades below $1, buys the discount and sells when the peg restores. Silent in calm markets by design.",
    portfolio: "Conservative",
    tone: "accent",
    standing: "funded",
    standingNote: "Armed · fires on a depeg",
    evidence:
      "Near-riskless when it fires (the discount to par IS the edge); costs nothing to keep watching. USDC printed $0.88 in March 2023 — being armed is the point.",
    terms: [],
  },
  {
    code: "F1",
    name: "FX carry",
    plain:
      "Holds the currency with the higher interest rate against the lower one and collects the difference daily — the oldest carry trade there is.",
    portfolio: "Conservative",
    tone: "accent",
    standing: "funded",
    standingNote: "Funded · best-validated strategy",
    evidence:
      "3 years of history: +4.3% with both components positive (carry +1.7%, price +2.7%), Sharpe 0.62, zero stops hit. Only 3 of 7 pairs clear the net-carry floor.",
    terms: ["carry"],
  },
  {
    code: "H1",
    name: "Crypto trend",
    plain:
      "Buys a coin when it breaks above its 100-day high and rides the move, selling on a trailing stop or a close below the 30-day low. Long-only, no leverage.",
    portfolio: "Aggressive",
    tone: "warn",
    standing: "funded",
    standingNote: "Funded · waiting for a breakout",
    evidence:
      "Positive in every tested parameter cell over ~2.7 years (+38–47% portfolio) — including on coins where just holding lost. Underperforms holding in a straight bull run; its value is defined exits.",
    terms: ["breakout", "stop"],
  },
  {
    code: "L2",
    name: "Cross-venue funding spread",
    plain:
      "Tries to harvest the gap between funding rates on two exchanges for the same coin. Sounds free; the gap disappears faster than it pays.",
    portfolio: "Experimental",
    tone: "down",
    standing: "shadow",
    standingNote: "Defunded by evidence · shadow only",
    evidence:
      "167 days, 24 venue pairs, every exit rule tested: loses money in all of them — the spread mean-reverts in ~1 day while a round trip costs ~27bp. Still scored so the verdict can update itself.",
    terms: ["spreadl2", "shadow"],
  },
  {
    code: "F2",
    name: "FX trend",
    plain:
      "Trend-following on currency pairs using moving averages. Currencies at 7% volatility range for months — the signal churned instead of riding.",
    portfolio: "Experimental",
    tone: "down",
    standing: "shadow",
    standingNote: "Defunded by evidence · shadow only",
    evidence:
      "3 years, 12 parameter combinations: negative in every single cell (−7.4% portfolio, 31% win rate). Its only winners were high-carry pairs where pure carry earned several times more.",
    terms: ["shadow"],
  },
  {
    code: "M2",
    name: "Dated-futures basis",
    plain:
      "Buys spot and shorts a dated future priced above it; the gap must close to zero at expiry, mechanically. Currently scored live at ~+1.7% net APR on the BTC quarterly.",
    portfolio: "Experimental",
    tone: "down",
    standing: "waiting",
    standingNote: "Scored · execution not yet built",
    evidence:
      "Deterministic convergence makes it structurally safer than funding carry. Honest execution needs dated-future settlement modelling — queued in ROADMAP rather than rushed.",
    terms: ["basis"],
  },
];

export default function StrategiesPage() {
  const perf = useLive<PerformanceResponse>("/api/performance", 30_000);
  const pnlOf = (code: string) =>
    perf.data?.report.byStrategy.find((s) => s.key === code);

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {STRATEGIES.map((s) => {
          const pnl = pnlOf(s.code);
          const total = pnl?.totalUsd ?? 0;
          return (
            <Panel
              key={s.code}
              label={`${s.code} · ${s.name.toUpperCase()}`}
              right={
                <Tag tone={s.standing === "funded" ? s.tone : "neutral"}>
                  {s.standing === "funded"
                    ? "FUNDED"
                    : s.standing === "shadow"
                      ? "SHADOW"
                      : "SCORED"}
                </Tag>
              }
            >
              <p className="text-[12px] leading-relaxed text-muted">
                {s.plain}
                {s.terms.map((t) => (
                  <Info key={t} term={t} className="ml-1 align-middle" />
                ))}
              </p>

              <div className="mt-3 flex items-center gap-2">
                <Micro>PORTFOLIO</Micro>
                <span className={cx("micro", s.tone === "accent" ? "text-accent" : s.tone === "warn" ? "text-warn" : "text-s3")}>
                  {s.portfolio.toUpperCase()}
                </span>
                <span className="micro text-dim">· {s.standingNote}</span>
              </div>

              {/* live record */}
              <div className="mt-3 grid grid-cols-4 gap-2 border-t border-line pt-3">
                <div>
                  <span className="flex items-center gap-1">
                    <Micro>TOTAL P&L</Micro>
                  </span>
                  <div
                    className={cx(
                      "tnum mt-1 text-[13px]",
                      total > 0 ? "text-up" : total < 0 ? "text-down" : "text-muted",
                    )}
                  >
                    {total >= 0 ? "+" : "−"}${Math.abs(total).toFixed(2)}
                  </div>
                </div>
                <div>
                  <span className="flex items-center gap-1">
                    <Micro>INCOME</Micro>
                    <Info term="income" />
                  </span>
                  <div className="tnum mt-1 text-[13px] text-up">
                    +${(pnl?.fundingUsd ?? 0).toFixed(2)}
                  </div>
                </div>
                <div>
                  <Micro>TRADES</Micro>
                  <div className="tnum mt-1 text-[13px] text-muted">{pnl?.trades ?? 0}</div>
                </div>
                <div>
                  <Micro>OPEN</Micro>
                  <div className="tnum mt-1 text-[13px] text-muted">
                    {pnl?.openPositions ?? 0}
                  </div>
                </div>
              </div>

              <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
                {s.evidence}
              </p>
            </Panel>
          );
        })}
      </div>

      <Panel label="THE PIPELINE EVERY STRATEGY WALKS" hint="GOVERNANCE.MD §3 — NO SKIPPING">
        <p className="text-[12px] leading-relaxed text-muted">
          Research → Backtest → Paper (shadow-scored
          <Info term="shadow" className="mx-1 align-middle" />) → Experimental
          capital → Core allocation. Deteriorating strategies are demoted the
          same way they were promoted: by evidence, recorded in ROADMAP.md.
          Capital sits exactly where the verdicts point — see Backtests for
          every verdict and Portfolios to move money.
        </p>
      </Panel>
    </div>
  );
}
