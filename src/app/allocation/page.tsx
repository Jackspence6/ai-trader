"use client";

/**
 * Allocation — dividing one account into separately-mandated sleeves.
 *
 * The screen has one job beyond setting numbers: making the trade being made
 * legible. Every sleeve shows what it is *for*, what it will not do, what its
 * primary failure mode is, and the drawdown to expect — next to the amount
 * being assigned to it.
 *
 * That framing is deliberate. It is very easy to move a slider toward "higher
 * return" and much harder to remember that the same slider moved the expected
 * drawdown, and that the return figure is a range with a negative end.
 */

import { useEffect, useMemo, useState } from "react";
import {
  applyPreset,
  computePortfolio,
  minimumViableCapital,
  PRESETS,
  reconcileAllocations,
  SLEEVES,
  type RiskBand,
  type SleeveAllocation,
  type SleeveState,
} from "@/lib/portfolio/sleeves";
import type { EngineConfig } from "@/lib/engine/config";
import { Money, useCurrency } from "@/lib/currency";
import { cx, Micro, Panel, Stat, StatusDot, Tag } from "@/components/ui";

const BAND_TONE: Record<RiskBand, "up" | "accent" | "warn" | "down"> = {
  low: "up",
  medium: "accent",
  high: "warn",
  "very-high": "down",
};

const BAND_LABEL: Record<RiskBand, string> = {
  low: "LOW RISK",
  medium: "MEDIUM RISK",
  high: "HIGH RISK",
  "very-high": "VERY HIGH RISK",
};

export default function AllocationPage() {
  const [saved, setSaved] = useState<EngineConfig | null>(null);
  // NAV is derived from the capital ledger — read-only here. Change it by
  // recording a deposit or withdrawal on Treasury.
  const [nav, setNav] = useState(0);
  const [draft, setDraft] = useState<SleeveAllocation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, fund] = await Promise.all([
          fetch("/api/config").then((r) => r.json()) as Promise<{ config: EngineConfig }>,
          fetch("/api/fund").then((r) => r.json()) as Promise<{ nav: { navUsd: number } }>,
        ]);
        setSaved(cfg.config);
        setDraft(cfg.config.sleeves);
        setNav(fund.nav.navUsd);
      } catch {
        setNote("Could not load configuration");
      }
    })();
  }, []);

  const portfolio = useMemo(
    () => computePortfolio(nav, draft ?? []),
    [nav, draft],
  );

  const dirty = useMemo(() => {
    if (!saved || !draft) return false;
    return SLEEVES.some((s) => {
      const a = saved.sleeves.find((x) => x.sleeveId === s.id);
      const b = draft.find((x) => x.sleeveId === s.id);
      return (
        a?.allocatedUsd !== b?.allocatedUsd ||
        a?.enabled !== b?.enabled ||
        a?.halted !== b?.halted
      );
    });
  }, [saved, draft]);

  async function save() {
    if (!draft || !saved) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...saved, sleeves: draft }),
      });
      const d = (await res.json()) as { config: EngineConfig; adjustments: string[] };
      setSaved(d.config);
      setDraft(d.config.sleeves);
      setNote(
        d.adjustments.length > 0
          ? `Saved with adjustments — ${d.adjustments.join("; ")}`
          : "Saved.",
      );
    } catch {
      setNote("Save failed — allocation unchanged");
    } finally {
      setBusy(false);
    }
  }

  function update(id: string, patch: Partial<SleeveAllocation>) {
    setDraft((d) =>
      (d ?? []).map((a) => (a.sleeveId === id ? { ...a, ...patch } : a)),
    );
  }

  if (!draft || !saved) {
    return <div className="p-4 text-[12px] text-dim">Loading allocation…</div>;
  }

  return (
    <div className="space-y-3 p-3">
      {/* --------------------------------------------------------- summary */}
      <Panel
        label="CAPITAL ALLOCATION"
        hint="ONE ACCOUNT, SEPARATELY MANDATED BOOKS"
        right={
          <div className="flex items-center gap-2">
            {portfolio.overAllocated && <Tag tone="down">OVER-ALLOCATED</Tag>}
            {dirty && <Tag tone="warn">UNSAVED</Tag>}
            <button
              onClick={() => setDraft(saved.sleeves)}
              disabled={!dirty || busy}
              className="micro border border-line-bright px-2 py-1 text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              REVERT
            </button>
            <button
              onClick={save}
              disabled={!dirty || busy}
              className="micro border border-accent/50 bg-accent/10 px-2.5 py-1 text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
            >
              {busy ? "SAVING…" : "SAVE"}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-5">
          <Stat
            label="NET ASSET VALUE"
            sub={
              <a href="/treasury" className="text-accent hover:underline">
                set via Treasury →
              </a>
            }
          >
            <Money usd={nav} />
          </Stat>

          <Stat label="ALLOCATED" sub={<span className="text-dim">across sleeves</span>}>
            <span className={cx(portfolio.overAllocated && "text-down")}>
              <Money usd={portfolio.totalAllocatedUsd} />
            </span>
          </Stat>

          <Stat
            label="RESERVE"
            sub={
              <span className="text-dim">
                {(portfolio.reserveShare * 100).toFixed(0)}% unassigned
              </span>
            }
          >
            <span className={cx(portfolio.reserveUsd < 0 ? "text-down" : "text-muted")}>
              <Money usd={portfolio.reserveUsd} />
            </span>
          </Stat>

          <Stat
            label="BLENDED TARGET"
            sub={<span className="text-dim">annualised, on total NAV</span>}
          >
            <span className="tnum text-[15px]">
              <span className={portfolio.blendedAprLow < 0 ? "text-down" : "text-up"}>
                {(portfolio.blendedAprLow * 100).toFixed(0)}%
              </span>
              <span className="text-dim"> … </span>
              <span className="text-up">
                {(portfolio.blendedAprHigh * 100).toFixed(0)}%
              </span>
            </span>
          </Stat>

          <Stat
            label="EXPECTED DRAWDOWN"
            sub={<span className="text-dim">capital-weighted</span>}
          >
            <span
              className={cx(
                "tnum text-[15px]",
                portfolio.blendedExpectedDrawdown > 0.3
                  ? "text-down"
                  : portfolio.blendedExpectedDrawdown > 0.15
                    ? "text-warn"
                    : "text-muted",
              )}
            >
              −{(portfolio.blendedExpectedDrawdown * 100).toFixed(0)}%
            </span>
          </Stat>
        </div>

        <AllocationBar portfolio={portfolio} />

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Micro>PRESETS</Micro>
          {Object.entries(PRESETS).map(([id, p]) => (
            <button
              key={id}
              onClick={() => setDraft(applyPreset(nav, id, draft))}
              title={p.description}
              className="micro border border-line-bright px-2 py-1 text-muted transition-colors hover:border-accent/40 hover:text-accent"
            >
              {p.label.toUpperCase()}
            </button>
          ))}
          <button
            onClick={() => {
              const r = reconcileAllocations(nav, draft);
              setDraft(r.allocations);
              if (r.adjustments.length) setNote(r.adjustments.join("; "));
            }}
            className="micro border border-line-bright px-2 py-1 text-muted transition-colors hover:text-ink"
            title="Scale allocations proportionally to fit inside NAV"
          >
            FIT TO NAV
          </button>
        </div>

        {note && (
          <div className="mt-3 border-t border-line pt-3 text-[11px] text-muted">{note}</div>
        )}
      </Panel>

      {/* ---------------------------------------------------------- sleeves */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {portfolio.sleeves.map((s) => (
          <SleeveCard
            key={s.def.id}
            state={s}
            navUsd={nav}
            onChange={(patch) => update(s.def.id, patch)}
          />
        ))}
      </div>

      {/* ------------------------------------------------------ the caveat */}
      <Panel label="HOW TO THINK ABOUT THIS" hint="READ BEFORE MOVING MONEY UP THE RISK CURVE">
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 text-[11.5px] leading-relaxed text-muted md:grid-cols-2">
          <p>
            <span className="text-ink">
              Higher risk does not reliably buy higher return.
            </span>{" "}
            It buys a wider range of outcomes in both directions. The Systematic
            sleeve targets up to 40% a year and can equally lose 20% — that is the
            same fact stated twice, not a good case and a bad case.
          </p>
          <p>
            <span className="text-ink">Sleeves fail independently.</span> Each has
            its own daily-loss and drawdown limits, and breaching one halts that
            sleeve alone. That is the actual point of dividing the account: the
            neutral book keeps earning while a directional book sits in timeout.
          </p>
          <p>
            <span className="text-ink">
              Splitting a small account is not diversification.
            </span>{" "}
            Each sleeve needs enough capital to place a position at the exchange
            minimum without breaching its own position cap. Below that floor a
            sleeve cannot trade at all, and the card says so rather than
            pretending to be funded.
          </p>
          <p>
            <span className="text-ink">Reserve is not wasted.</span> Unallocated
            cash is what lets you add to a sleeve after a drawdown rather than
            during one, and it is the buffer that keeps a margin top-up from
            becoming a forced unwind.
          </p>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------- alloc bar */

function AllocationBar({ portfolio }: { portfolio: ReturnType<typeof computePortfolio> }) {
  const colors: Record<string, string> = {
    core: "var(--color-up)",
    accumulation: "var(--color-s1)",
    systematic: "var(--color-warn)",
    opportunistic: "var(--color-down)",
  };

  const denom = Math.max(portfolio.navUsd, portfolio.totalAllocatedUsd, 1);

  return (
    <div className="mt-5">
      <div className="flex h-2 w-full overflow-hidden bg-raised">
        {portfolio.sleeves.map((s) =>
          s.allocatedUsd > 0 ? (
            <div
              key={s.def.id}
              title={`${s.def.name}: ${((s.allocatedUsd / denom) * 100).toFixed(1)}%`}
              style={{
                width: `${(s.allocatedUsd / denom) * 100}%`,
                background: colors[s.def.id],
                opacity: s.allocation.enabled ? 0.9 : 0.3,
              }}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {portfolio.sleeves.map((s) => (
          <span key={s.def.id} className="micro flex items-center gap-1.5">
            <span
              className="block size-2"
              style={{
                background: colors[s.def.id],
                opacity: s.allocation.enabled ? 0.9 : 0.3,
              }}
            />
            <span className={s.allocation.enabled ? "text-muted" : "text-dim"}>
              {s.def.name}
            </span>
            <span className="tnum text-dim">
              {((s.allocatedUsd / denom) * 100).toFixed(0)}%
            </span>
          </span>
        ))}
        <span className="micro flex items-center gap-1.5">
          <span className="block size-2 bg-raised" />
          <span className="text-dim">Reserve</span>
          <span className="tnum text-dim">
            {(Math.max(portfolio.reserveShare, 0) * 100).toFixed(0)}%
          </span>
        </span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- sleeve card */

function SleeveCard({
  state,
  navUsd,
  onChange,
}: {
  state: SleeveState;
  navUsd: number;
  onChange: (patch: Partial<SleeveAllocation>) => void;
}) {
  const { def, allocation, allocatedUsd } = state;
  const { symbol } = useCurrency();
  const minViable = minimumViableCapital(def);

  return (
    <Panel
      label={def.name.toUpperCase()}
      hint={def.strategies.join(" · ")}
      right={
        <div className="flex items-center gap-2">
          <Tag tone={BAND_TONE[def.band]}>{BAND_LABEL[def.band]}</Tag>
          <button
            onClick={() => onChange({ enabled: !allocation.enabled })}
            aria-pressed={allocation.enabled}
            className={cx(
              "micro border px-2 py-1 transition-colors",
              allocation.enabled
                ? "border-up/50 bg-up/10 text-up"
                : "border-line-bright text-dim hover:text-muted",
            )}
          >
            {allocation.enabled ? "ENABLED" : "OFF"}
          </button>
        </div>
      }
    >
      <p className="mb-4 text-[12px] leading-relaxed text-muted">{def.mandate}</p>

      {/* amount */}
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <Micro>ALLOCATION</Micro>
        <div className="flex items-baseline gap-1.5">
          <span className="micro text-dim">{symbol === "$" ? "USD" : `USD → ${symbol}`}</span>
          <input
            type="number"
            min={0}
            step={10}
            value={Number(allocatedUsd.toFixed(2))}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) onChange({ allocatedUsd: n });
            }}
            className="tnum w-28 border border-line-bright bg-raised/60 px-1.5 py-1 text-right text-[12px] text-ink outline-none focus:border-accent/50"
          />
        </div>
      </div>

      <input
        type="range"
        aria-label={`${def.name} allocation`}
        min={0}
        max={Math.max(navUsd, 1)}
        step={Math.max(navUsd / 200, 1)}
        value={Math.min(allocatedUsd, Math.max(navUsd, 1))}
        onChange={(e) => onChange({ allocatedUsd: Number(e.target.value) })}
        disabled={navUsd <= 0}
        className="h-1 w-full cursor-pointer appearance-none bg-raised accent-[var(--color-accent)] disabled:opacity-40"
      />

      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-dim">
          {navUsd > 0
            ? `${(state.shareOfNav * 100).toFixed(1)}% of NAV`
            : "Set NAV to allocate"}
        </span>
        <span className="text-muted">
          <Money usd={allocatedUsd} />
        </span>
      </div>

      {/* status */}
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <StatusDot
          state={state.tradable ? "ok" : allocation.halted ? "bad" : "idle"}
          pulse={state.tradable}
        />
        <span className="text-[11.5px] text-muted">
          {state.tradable ? "Ready to trade" : state.blockedReason}
        </span>
      </div>

      {/* numbers */}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="TARGET APR" sub={<span className="text-dim">range</span>}>
          <span className="tnum text-[13px]">
            <span className={def.targetAprLow < 0 ? "text-down" : "text-up"}>
              {(def.targetAprLow * 100).toFixed(0)}%
            </span>
            <span className="text-dim"> … </span>
            <span className="text-up">{(def.targetAprHigh * 100).toFixed(0)}%</span>
          </span>
        </Stat>
        <Stat label="EXPECT DD" sub={<span className="text-dim">not a limit</span>}>
          <span className="tnum text-[13px] text-warn">
            −{(def.expectedMaxDrawdown * 100).toFixed(0)}%
          </span>
        </Stat>
        <Stat label="HALTS AT" sub={<span className="text-dim">own drawdown</span>}>
          <span className="tnum text-[13px] text-muted">
            <Money usd={state.drawdownLimitUsd} dp={0} />
          </span>
        </Stat>
        <Stat label="MAX POSITION" sub={<span className="text-dim">of sleeve</span>}>
          <span className="tnum text-[13px] text-muted">
            <Money usd={state.maxPositionUsd} dp={0} />
          </span>
        </Stat>
      </div>

      {/* honesty block */}
      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <p className="text-[11px] leading-relaxed text-dim">
          <span className="text-muted">Primary risk — </span>
          {def.primaryRisk}
        </p>
        <p className="text-[11px] leading-relaxed text-dim">
          <span className="text-muted">Does not — </span>
          {def.doesNotDo}
        </p>
        <p className="text-[11px] leading-relaxed text-dim">
          <span className="text-muted">Minimum viable capital — </span>
          <span className="tnum">${minViable.toFixed(0)}</span>. Below this the
          sleeve cannot place a position at the exchange minimum without breaching
          its own {(def.limits.maxPositionPct * 100).toFixed(0)}% position cap.
        </p>
      </div>
    </Panel>
  );
}
