"use client";

/**
 * What this desk has measured, and what it found.
 *
 * Two halves. The top is the live go/no-go tracker: how many usable
 * opportunities a day the scanner is finding, and what share of them were
 * actually caught. The bottom is the standing record — measurements already
 * taken, with dates, including the ones that came back negative. A negative
 * result that is written down is a finding; one that is quietly dropped becomes
 * a thing someone rebuilds next quarter.
 */

import { useEffect, useState } from "react";
import { Panel, Micro, Stat, Tag, Meter, cx } from "@/components/ui";
import { zar, pct } from "@/lib/events/format";
import type { AnalyticsSummary } from "@/lib/events/types";

type Payload = (Partial<AnalyticsSummary> & { source?: string }) | null;

const FINDINGS = [
  {
    date: "2026-08-25",
    title: "Two South African books do not cross",
    tone: "down" as const,
    body:
      "38 events quoted by both Sunbet and Betway. Across 33 three-way books and 164 two-way books, zero arbitrage. Tightest three-way −2.4%; tightest two-way −1.3% on Southampton v West Ham Over/Under 3.5. Two books leave a gap that a third and fourth could plausibly close, because best-of-N tightens quickly.",
  },
  {
    date: "2026-08-25",
    title: "Prediction-market internal arbitrage is empty",
    tone: "down" as const,
    body:
      "440 markets across 29 events read with zero parse errors and zero arbitrage. A direct probe of the tightest books put them at 1.0010 raw — roughly 0.1% inside the line before the taker fee applies at all. A validated negative: the scanner works and the market is efficient.",
  },
  {
    date: "2026-08-25",
    title: "Promotional hedging is the only positive edge measured",
    tone: "up" as const,
    body:
      "At a typical 4% two-book overround a 5× rollover costs about 7.6% of turnover against a 20% break-even, so the headroom is roughly an order of magnitude — unlike a 1% arbitrage, which has none. R2,000 of capital clears about R683 of expected value in around two weeks.",
  },
  {
    date: "pending",
    title: "Book against prediction market",
    tone: "neutral" as const,
    body:
      "Never measured. Both sides are individually tested and the fee-adjusted conversion is covered by the cross-language parity suite, but the two have never been compared on live data. Sunbet carries 183 American-football events and the prediction side is NFL-heavy, so the overlap exists.",
  },
];

export default function EventsResearchPage() {
  const [data, setData] = useState<Payload>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/events/analytics", { cache: "no-store" });
        setData(await res.json());
      } catch {
        setData({ source: "error" });
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const live = data?.source === "db";
  const verdict = data?.go_no_go ?? "PENDING";

  return (
    <div className="space-y-3">
      <Panel
        label="Go / no-go"
        hint="does the scanner find enough, and can a person catch it"
        right={
          <Tag tone={verdict === "GO" ? "up" : verdict === "NO-GO" ? "down" : "neutral"}>
            {verdict}
          </Tag>
        }
      >
        {live ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Usable per day" sub={<span className="micro text-dim">target {data?.target_per_day}</span>}>
                <span className="tnum text-ink">{data?.usable_per_day ?? 0}</span>
              </Stat>
              <Stat label="Days observed" sub={<span className="micro text-dim">of {data?.dry_run_days_target}</span>}>
                <span className="tnum text-ink">{data?.days_observed ?? 0}</span>
              </Stat>
              <Stat label="Capture rate" sub={<span className="micro text-dim">placed / scored</span>}>
                <span className="tnum text-ink">{pct((data?.capture_rate ?? 0) * 100, 1)}</span>
              </Stat>
              <Stat label="Realised" sub={<span className="micro text-dim">of {zar(data?.theoretical_profit_zar ?? 0)} theoretical</span>}>
                <span className="tnum text-ink">{zar(data?.realized_profit_zar ?? 0)}</span>
              </Stat>
            </div>
            <div className="mt-3 space-y-2 border-t border-line pt-3">
              <Meter
                used={data?.usable_per_day ?? 0}
                limit={data?.target_per_day ?? 1}
                label="Usable opportunities per day"
              />
              <Meter
                used={data?.days_observed ?? 0}
                limit={data?.dry_run_days_target ?? 1}
                label="Dry-run days observed"
              />
            </div>
          </>
        ) : (
          <div className="py-6 text-center">
            <Micro className="mb-2 block text-dim">
              {loaded ? "NO MEASUREMENT YET" : "LOADING"}
            </Micro>
            <p className="mx-auto max-w-lg text-[12px] leading-relaxed text-muted">
              The tracker needs the scanner to have run against this database. It is the
              measurement that decides whether this desk is viable: the specification&apos;s
              own benchmark is that if manual capture on live arbitrage lands under 30%,
              promotional hedging is the primary edge and cross-book arbitrage is a
              research project.
            </p>
          </div>
        )}
      </Panel>

      <Panel label="Standing record" hint="measurements taken, including the negative ones">
        <div className="space-y-3">
          {FINDINGS.map((f) => (
            <div key={f.title} className="border-l-2 border-line-bright pl-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="tnum text-[10.5px] text-dim">{f.date}</span>
                <span
                  className={cx(
                    "text-[12.5px]",
                    f.tone === "up" ? "text-up" : f.tone === "down" ? "text-ink" : "text-muted",
                  )}
                >
                  {f.title}
                </span>
                {f.date === "pending" && <Tag tone="warn">NOT MEASURED</Tag>}
              </div>
              <p className="mt-1 max-w-4xl text-[11px] leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
