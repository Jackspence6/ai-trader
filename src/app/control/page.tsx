"use client";

/**
 * Control — the thresholds and limits the engine trades under.
 *
 * Kept deliberately separate from Strategies. Strategies decides *which*
 * strategies run; this decides the rules they all run within. Merging the two
 * makes it easy to change a global risk limit while believing you changed one
 * strategy's parameter, which is a bad mistake to make cheaply.
 *
 * Every change is diffed against the saved value before it is written, clamped
 * to documented bounds, and audit-logged. Nothing applies until Save.
 */

import { useEffect, useMemo, useState } from "react";
import {
  CONFIG_BOUNDS,
  DEFAULT_CONFIG,
  PERCENT_FIELDS,
  type EngineConfig,
} from "@/lib/engine/config";
import { resolveTier } from "@/lib/calc/tiers";
import type { AuditEntry } from "@/lib/engine/store";
import { Money } from "@/lib/currency";
import { cx, Micro, Panel, Stat, Tag } from "@/components/ui";

type ConfigResponse = { config: EngineConfig; audit: AuditEntry[] };

const GROUPS: { label: string; hint: string; fields: (keyof EngineConfig)[] }[] = [
  {
    label: "CAPITAL",
    hint: "NAV IS DERIVED — SET IT VIA DEPOSITS ON TREASURY",
    fields: ["shadowNotionalUsd"],
  },
  {
    label: "ECONOMICS",
    hint: "WHEN AN EDGE IS WORTH TAKING",
    fields: ["minNetEdgeBps", "minFundingApr", "expectedHoldDays"],
  },
  {
    label: "POSITION SHAPE",
    hint: "LEVERAGE AND SIZING",
    fields: [
      "perpLeverage",
      "maxLeverage",
      "legNotionalPctOfNav",
      "targetAnnualVol",
      "maxPositionPctOfNav",
    ],
  },
  {
    label: "REGIME FILTER",
    hint: "SEPARATING A REGIME FROM A SPIKE",
    fields: ["fundingRegimeWindow", "minPositiveShare"],
  },
  {
    label: "INTEGRITY & CIRCUIT BREAKERS",
    hint: "WHEN TO STOP",
    fields: ["maxDataAgeSeconds", "dailyLossLimitPct", "maxDrawdownPct"],
  },
];

export default function ControlPage() {
  const [saved, setSaved] = useState<EngineConfig | null>(null);
  const [draft, setDraft] = useState<EngineConfig | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: ConfigResponse) => {
        setSaved(d.config);
        setDraft(d.config);
        setAudit(d.audit);
      })
      .catch(() => setNote("Could not load configuration"));
  }, []);

  const dirty = useMemo(() => {
    if (!saved || !draft) return [];
    return (Object.keys(draft) as (keyof EngineConfig)[]).filter(
      (k) => draft[k] !== saved[k],
    );
  }, [saved, draft]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const d = (await res.json()) as { config: EngineConfig; adjustments: string[] };
      setSaved(d.config);
      setDraft(d.config);
      setNote(
        d.adjustments.length > 0
          ? `Saved with adjustments — ${d.adjustments.join("; ")}`
          : "Saved.",
      );
      const fresh = (await fetch("/api/config").then((r) => r.json())) as ConfigResponse;
      setAudit(fresh.audit);
    } catch {
      setNote("Save failed — configuration unchanged");
    } finally {
      setBusy(false);
    }
  }

  if (!draft || !saved) {
    return <div className="p-4 text-[12px] text-dim">Loading configuration…</div>;
  }

  const tier = resolveTier(draft.navUsd, 0, "T0").current;

  return (
    <div className="space-y-3 p-3">
      {/* -------------------------------------------------------- header */}
      <Panel
        label="ENGINE CONTROL"
        hint="THRESHOLDS THE RISK GATE ENFORCES"
        right={
          <div className="flex items-center gap-2">
            {dirty.length > 0 && <Tag tone="warn">{dirty.length} UNSAVED</Tag>}
            <button
              onClick={() => setDraft(saved)}
              disabled={dirty.length === 0 || busy}
              className="micro border border-line-bright px-2 py-1 text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              REVERT
            </button>
            <button
              onClick={() => setDraft({ ...DEFAULT_CONFIG, navUsd: draft.navUsd })}
              disabled={busy}
              className="micro border border-line-bright px-2 py-1 text-muted transition-colors hover:text-ink disabled:opacity-40"
              title="Restore every threshold to its conservative default, keeping NAV"
            >
              DEFAULTS
            </button>
            <button
              onClick={save}
              disabled={dirty.length === 0 || busy}
              className="micro border border-accent/50 bg-accent/10 px-2.5 py-1 text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
            >
              {busy ? "SAVING…" : "SAVE"}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          <Stat label="CURRENT TIER" sub={<span className="text-dim">{tier.name}</span>}>
            <span className="text-[15px] text-accent">{tier.id}</span>
          </Stat>
          <Stat
            label="LIVE STRATEGIES"
            sub={<span className="text-dim">permitted at this tier</span>}
          >
            <span className="text-[15px] text-ink">
              {tier.liveStrategies.length > 0 ? tier.liveStrategies.join(" · ") : "none"}
            </span>
          </Stat>
          <Stat label="HALT CONTROL" sub={<span className="text-dim">see Risk screen</span>}>
            <span className="text-[15px] text-muted">separate</span>
          </Stat>
          <Stat label="MAX POSITIONS" sub={<span className="text-dim">concurrent</span>}>
            <span className="tnum text-[15px] text-ink">{tier.maxConcurrentPositions}</span>
          </Stat>
        </div>

        {note && (
          <div className="mt-3 border-t border-line pt-3 text-[11px] text-muted">{note}</div>
        )}
      </Panel>

      {/* --------------------------------------------------------- groups */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <Panel key={g.label} label={g.label} hint={g.hint}>
            <div className="space-y-5">
              {g.fields.map((f) => (
                <Field
                  key={f}
                  field={f}
                  value={draft[f] as number}
                  savedValue={saved[f] as number}
                  onChange={(v) => setDraft({ ...draft, [f]: v })}
                />
              ))}
            </div>
          </Panel>
        ))}

        <Panel label="CHANGE LOG" hint="EVERY CONFIG WRITE, NEWEST FIRST">
          {audit.length === 0 ? (
            <p className="text-[11px] text-dim">
              No changes recorded yet. Every save is logged here with a field-level
              diff.
            </p>
          ) : (
            <ul className="space-y-3">
              {audit.map((a, i) => (
                <li key={`${a.ts}-${i}`} className="border-b border-line/60 pb-3 last:border-0">
                  <Micro className="mb-1.5">
                    {new Date(a.ts).toISOString().slice(0, 19).replace("T", " ")} UTC
                  </Micro>
                  <ul className="space-y-1">
                    {a.changes.map((c) => (
                      <li key={c.field} className="text-[11.5px] text-muted">
                        <span className="text-ink">{c.field}</span>{" "}
                        <span className="text-dim">{String(c.from)}</span>
                        <span className="text-dim"> → </span>
                        <span className="text-accent">{String(c.to)}</span>
                      </li>
                    ))}
                    {a.adjustments.map((adj) => (
                      <li key={adj} className="text-[11.5px] text-warn">
                        clamped · {adj}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel label="WHAT THESE CONTROL" hint="READ BEFORE LOOSENING ANYTHING">
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 text-[11.5px] leading-relaxed text-muted md:grid-cols-2">
          <p>
            <span className="text-ink">Loosening is not free.</span> Every
            threshold here exists because some specific way of losing money
            exists. Lowering the minimum net edge does not create opportunities —
            it lets through the ones the cost model already judged unprofitable.
          </p>
          <p>
            <span className="text-ink">Expected hold is the sharpest knob.</span>{" "}
            It divides the entry cost, so raising it makes thin edges look viable.
            That is only honest if funding actually persists that long — which is
            what the regime filter is for.
          </p>
          <p>
            <span className="text-ink">Leverage buys less than it looks.</span>{" "}
            Capital efficiency is L/(L+1): 3× recovers 75% of headline APR, 5×
            recovers 83%. Past that you gain very little yield and move
            liquidation materially closer.
          </p>
          <p>
            <span className="text-ink">NAV drives everything.</span> It sets the
            capital tier, which sets which strategies may go live at all. It stays
            zero until real exchange accounts are linked — a dashboard showing
            invented capital is the most dangerous kind of wrong.
          </p>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ field */

function Field({
  field,
  value,
  savedValue,
  onChange,
}: {
  field: keyof EngineConfig;
  value: number;
  savedValue: number;
  onChange: (v: number) => void;
}) {
  const b = CONFIG_BOUNDS[field as string];
  if (!b) return null;

  const isPct = PERCENT_FIELDS.has(field as string);
  const display = isPct ? value * 100 : value;
  const min = isPct ? b.min * 100 : b.min;
  const max = isPct ? b.max * 100 : b.max;
  const step = isPct ? Math.max(b.step * 100, 0.1) : b.step;
  const changed = value !== savedValue;
  const isMoney = b.unit === "$";

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label
          htmlFor={`f-${field}`}
          className={cx("text-[12px]", changed ? "text-accent" : "text-ink")}
        >
          {b.label}
          {changed && <span className="ml-1.5 text-[10px] text-warn">●</span>}
        </label>
        <div className="flex items-baseline gap-1.5">
          <input
            id={`f-${field}`}
            type="number"
            value={Number(display.toFixed(4))}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              onChange(isPct ? n / 100 : n);
            }}
            className={cx(
              "tnum w-24 border bg-raised/60 px-1.5 py-1 text-right text-[12px] text-ink outline-none transition-colors",
              changed ? "border-accent/50" : "border-line-bright focus:border-accent/50",
            )}
          />
          <span className="micro w-4 text-dim">{isPct ? "%" : b.unit}</span>
        </div>
      </div>

      <input
        type="range"
        aria-label={b.label}
        value={display}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(isPct ? n / 100 : n);
        }}
        className="h-1 w-full cursor-pointer appearance-none bg-raised accent-[var(--color-accent)]"
      />

      <div className="mt-1.5 flex items-baseline justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-dim">{b.help}</p>
        {isMoney && value > 0 && (
          <span className="shrink-0 text-[11px] text-dim">
            <Money usd={value} dp={0} />
          </span>
        )}
      </div>
    </div>
  );
}
