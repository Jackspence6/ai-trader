"use client";

/**
 * Portfolios — fund, separate, and judge the three books (GOVERNANCE.md).
 *
 * The page answers the operator's three questions without any digging:
 * WHICH portfolio is which (three colour-coded cards, each with its
 * objective and charter limits on its face), WHAT money is where
 * (allocated / deployed / available per portfolio, per member stream), and
 * HOW each is doing (P&L split, drawdown against its own charter limit).
 *
 * Funding happens here, per portfolio, and every save requires a written
 * reason — capital movements are logged with their justification, per the
 * charter. The API (/api/portfolios) is the truth; this page is the paint.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import { cx, Meter, Micro, Panel, Stat, Tag } from "@/components/ui";

type Member = {
  sleeveId: string;
  name: string;
  strategies: string[];
  allocatedUsd: number;
  enabled: boolean;
  halted: boolean;
  deployedUsd: number;
  openPositions: number;
  pnl: {
    realisedUsd: number;
    fundingUsd: number;
    feesUsd: number;
    unrealisedUsd: number | null;
    totalUsd: number;
  };
};

type Portfolio = {
  id: string;
  name: string;
  objective: string;
  maxShareOfNav: number;
  maxDrawdownPct: number;
  allocatedUsd: number;
  deployedUsd: number;
  availableUsd: number;
  equityUsd: number;
  capUsd: number;
  capUsedPct: number;
  drawdownPct: number;
  anyHalted: boolean;
  pnl: Member["pnl"];
  members: Member[];
};

type PortfoliosResponse = {
  navUsd: number;
  allocatedTotal: number;
  reserveUsd: number;
  portfolios: Portfolio[];
};

type AuditEntry = {
  ts: number;
  reason?: string;
  changes: { field: string }[];
};

/** Each portfolio's visual identity — recognisable at a glance, everywhere. */
const TONE: Record<
  string,
  { border: string; text: string; tag: "accent" | "warn" | "down" }
> = {
  conservative: { border: "border-l-accent", text: "text-accent", tag: "accent" },
  aggressive: { border: "border-l-warn", text: "text-warn", tag: "warn" },
  experimental: { border: "border-l-s3", text: "text-s3", tag: "down" },
};

export default function PortfoliosPage() {
  const live = useLive<PortfoliosResponse>("/api/portfolios", 25_000);
  const cfg = useLive<{ audit: AuditEntry[] }>("/api/config", 60_000);

  // Draft allocations, keyed by sleeveId. Initialised from live data once.
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const data = live.data;

  useEffect(() => {
    if (data && draft === null) {
      const d: Record<string, number> = {};
      for (const p of data.portfolios)
        for (const m of p.members) d[m.sleeveId] = m.allocatedUsd;
      // Seeding a form from freshly-fetched external data is the sanctioned
      // effect use; it runs once per load cycle, not per render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(d);
    }
  }, [data, draft]);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return data.portfolios.some((p) =>
      p.members.some((m) => (draft[m.sleeveId] ?? 0) !== m.allocatedUsd),
    );
  }, [data, draft]);

  /** Charter check on the DRAFT, so a violation is visible before saving. */
  const draftViolations = useMemo(() => {
    if (!data || !draft) return [];
    return data.portfolios
      .map((p) => {
        const proposed = p.members.reduce(
          (a, m) => a + Math.max(draft[m.sleeveId] ?? 0, 0),
          0,
        );
        return { id: p.id, name: p.name, proposed, capUsd: p.capUsd };
      })
      .filter((v) => v.proposed > v.capUsd);
  }, [data, draft]);

  const draftTotal = useMemo(() => {
    if (!draft) return 0;
    return Object.values(draft).reduce((a, v) => a + Math.max(v, 0), 0);
  }, [draft]);

  const save = useCallback(async () => {
    if (!data || !draft || !reason.trim()) return;
    setSaving(true);
    setSaved(null);
    try {
      const sleeves = data.portfolios.flatMap((p) =>
        p.members.map((m) => ({
          sleeveId: m.sleeveId,
          allocatedUsd: Math.max(draft[m.sleeveId] ?? 0, 0),
          // Funding a sleeve enables it; zeroing it disables it. One mental
          // model: money in = on, money out = off.
          enabled: (draft[m.sleeveId] ?? 0) > 0,
          halted: m.halted,
        })),
      );
      await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sleeves, reason: reason.trim() }),
      });
      setSaved(`Saved — "${reason.trim()}"`);
      setReason("");
      setDraft(null); // re-seed from live truth
      live.refresh();
      cfg.refresh();
    } finally {
      setSaving(false);
    }
  }, [data, draft, reason, live, cfg]);

  return (
    <div className="space-y-3 p-3">
      {/* ------------------------------------------------ headline numbers */}
      <div className="grid grid-cols-3 gap-3">
        <Panel>
          <Stat label="TOTAL CAPITAL" sub={<span className="text-dim">fund NAV</span>}>
            <span className="tnum text-[19px] text-ink">
              {data ? <Money usd={data.navUsd} /> : "—"}
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="ALLOCATED" sub={<span className="text-dim">across portfolios</span>}>
            <span className="tnum text-[19px] text-muted">
              {data ? <Money usd={data.allocatedTotal} /> : "—"}
            </span>
          </Stat>
        </Panel>
        <Panel>
          <Stat label="RESERVE" sub={<span className="text-dim">unallocated buffer</span>}>
            <span className="tnum text-[19px] text-muted">
              {data ? <Money usd={data.reserveUsd} /> : "—"}
            </span>
          </Stat>
        </Panel>
      </div>

      {/* ------------------------------------------------- portfolio cards */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {(data?.portfolios ?? []).map((p) => {
          const tone = TONE[p.id] ?? TONE.experimental;
          const draftAlloc = p.members.reduce(
            (a, m) => a + Math.max(draft?.[m.sleeveId] ?? m.allocatedUsd, 0),
            0,
          );
          return (
            <section
              key={p.id}
              className={cx(
                "ticked relative border border-line border-l-2 bg-panel/70",
                tone.border,
              )}
            >
              {/* header */}
              <header className="flex items-start justify-between gap-2 border-b border-line px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className={cx("text-[13px] font-medium tracking-wide", tone.text)}>
                      {p.name.toUpperCase()}
                    </h2>
                    {p.anyHalted ? (
                      <Tag tone="down">HALTED</Tag>
                    ) : p.allocatedUsd > 0 ? (
                      <Tag tone={tone.tag}>ACTIVE</Tag>
                    ) : (
                      <Tag>UNFUNDED</Tag>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-dim">{p.objective}</p>
                </div>
              </header>

              {/* money */}
              <div className="grid grid-cols-3 gap-2 border-b border-line px-3 py-3">
                <Stat label="ALLOCATED">
                  <span className="tnum text-[15px] text-ink">
                    ${p.allocatedUsd.toLocaleString("en-US")}
                  </span>
                </Stat>
                <Stat label="DEPLOYED">
                  <span className="tnum text-[15px] text-muted">
                    ${p.deployedUsd.toFixed(0)}
                  </span>
                </Stat>
                <Stat label="AVAILABLE">
                  <span className="tnum text-[15px] text-muted">
                    ${p.availableUsd.toFixed(0)}
                  </span>
                </Stat>
              </div>

              {/* P&L split */}
              <div className="grid grid-cols-4 gap-2 border-b border-line px-3 py-2.5">
                {(
                  [
                    ["INCOME", p.pnl.fundingUsd],
                    ["REALISED", p.pnl.realisedUsd],
                    ["UNREAL.", p.pnl.unrealisedUsd ?? 0],
                    ["TOTAL", p.pnl.totalUsd],
                  ] as const
                ).map(([label, v]) => (
                  <div key={label} className="min-w-0">
                    <Micro>{label}</Micro>
                    <div
                      className={cx(
                        "tnum mt-1 text-[12.5px]",
                        v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted",
                      )}
                    >
                      {v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>

              {/* charter limits */}
              <div className="space-y-2.5 border-b border-line px-3 py-3">
                <Meter
                  used={p.drawdownPct * 100}
                  limit={p.maxDrawdownPct * 100}
                  label="DRAWDOWN VS CHARTER HALT"
                  unit="%"
                />
                <Meter
                  used={p.allocatedUsd}
                  limit={Math.max(p.capUsd, 1)}
                  label={`CHARTER CAP · ≤${(p.maxShareOfNav * 100).toFixed(0)}% OF NAV`}
                  unit="$"
                />
              </div>

              {/* member streams + funding inputs */}
              <div className="px-3 py-2.5">
                <Micro className="mb-2">STREAMS · FUND EACH DIRECTLY</Micro>
                <div className="space-y-2.5">
                  {p.members.map((m) => (
                    <div key={m.sleeveId} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="truncate text-[12px] text-ink">{m.name}</span>
                          <span className="micro text-dim">{m.strategies.join("·")}</span>
                          {m.halted && <Tag tone="down">HALT</Tag>}
                        </div>
                        <div className="micro mt-0.5 text-dim">
                          {m.openPositions} open · ${m.deployedUsd.toFixed(0)} deployed ·{" "}
                          <span className={m.pnl.totalUsd >= 0 ? "text-up" : "text-down"}>
                            {m.pnl.totalUsd >= 0 ? "+" : "−"}$
                            {Math.abs(m.pnl.totalUsd).toFixed(2)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="micro text-dim">$</span>
                        <input
                          type="number"
                          min={0}
                          step={100}
                          value={draft?.[m.sleeveId] ?? m.allocatedUsd}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...(d ?? {}),
                              [m.sleeveId]: Number(e.target.value),
                            }))
                          }
                          className={cx(
                            "tnum w-20 border border-line bg-raised/40 px-1.5 py-1 text-right text-[12px] text-ink",
                            "focus:border-accent focus:outline-none",
                            (draft?.[m.sleeveId] ?? m.allocatedUsd) !== m.allocatedUsd &&
                              "border-accent/60",
                          )}
                          aria-label={`Allocation for ${m.name}`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* draft footprint for this card */}
              {draft && draftAlloc !== p.allocatedUsd && (
                <div className="border-t border-line px-3 py-2">
                  <span className="micro text-accent">
                    DRAFT: ${draftAlloc.toLocaleString("en-US")} (
                    {draftAlloc > p.allocatedUsd ? "+" : ""}
                    {(draftAlloc - p.allocatedUsd).toLocaleString("en-US")})
                  </span>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* ------------------------------------------------------ save panel */}
      <Panel
        label="MOVE CAPITAL"
        hint="EVERY MOVEMENT IS LOGGED WITH ITS REASON — GOVERNANCE.MD §2"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-2">
            <Micro>DRAFT TOTAL</Micro>
            <span
              className={cx(
                "tnum text-[13px]",
                data && draftTotal > data.navUsd ? "text-down" : "text-ink",
              )}
            >
              ${draftTotal.toLocaleString("en-US")}
            </span>
            <span className="micro text-dim">OF ${data?.navUsd.toFixed(0) ?? "—"} NAV</span>
          </div>

          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this capital moving? (required)"
            className="min-w-[260px] flex-1 border border-line bg-raised/40 px-2.5 py-1.5 text-[12px] text-ink placeholder:text-dim focus:border-accent focus:outline-none"
            aria-label="Reason for capital movement"
          />

          <button
            onClick={save}
            disabled={!dirty || !reason.trim() || saving || draftViolations.length > 0}
            className={cx(
              "micro border px-3 py-2 transition-colors",
              dirty && reason.trim() && draftViolations.length === 0
                ? "border-accent bg-accent/10 text-accent hover:bg-accent/20"
                : "cursor-not-allowed border-line text-dim",
            )}
          >
            {saving ? "SAVING…" : "SAVE ALLOCATIONS"}
          </button>
        </div>

        {draftViolations.length > 0 && (
          <p className="mt-2 text-[11.5px] text-down">
            Charter violation:{" "}
            {draftViolations
              .map(
                (v) =>
                  `${v.name} $${v.proposed.toLocaleString("en-US")} exceeds its cap $${v.capUsd.toFixed(0)}`,
              )
              .join(" · ")}{" "}
            — reduce before saving.
          </p>
        )}
        {data && draftTotal > data.navUsd && (
          <p className="mt-2 text-[11.5px] text-warn">
            Draft exceeds NAV — allocations will be scaled proportionally on save.
          </p>
        )}
        {saved && <p className="mt-2 text-[11.5px] text-up">{saved}</p>}
        {!dirty && !saved && (
          <p className="mt-2 text-[11px] text-dim">
            Adjust any stream&apos;s allocation above; funding a stream enables it,
            zeroing it disables it. Nothing saves without a reason.
          </p>
        )}
      </Panel>

      {/* ---------------------------------------------------- audit trail */}
      <Panel label="CAPITAL MOVEMENTS" hint="THE AUDIT TRAIL, NEWEST FIRST" flush>
        <div className="max-h-64 overflow-y-auto">
          {(cfg.data?.audit ?? [])
            .filter((a) => a.changes.some((c) => c.field === "sleeves"))
            .slice(0, 12)
            .map((a) => (
              <div
                key={a.ts}
                className="flex items-baseline justify-between gap-3 border-b border-line/60 px-3 py-2"
              >
                <span className="text-[12px] text-muted">
                  {a.reason ?? (
                    <span className="text-dim">no reason recorded (pre-charter)</span>
                  )}
                </span>
                <span className="tnum micro shrink-0 text-dim">
                  {new Date(a.ts).toISOString().slice(0, 16).replace("T", " ")} UTC
                </span>
              </div>
            ))}
          {(cfg.data?.audit ?? []).filter((a) =>
            a.changes.some((c) => c.field === "sleeves"),
          ).length === 0 && (
            <p className="px-3 py-3 text-[12px] text-dim">
              No capital movements recorded yet.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
