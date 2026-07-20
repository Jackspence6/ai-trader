"use client";

import { resolveTier, TIERS, PROMOTION_HOLD_DAYS, type TierId } from "@/lib/calc/tiers";
import { Money } from "@/lib/currency";
import { cx, Micro } from "./ui";

/**
 * The capital ladder — capability gated on NAV.
 *
 * Doubles as the system roadmap: it shows exactly what the next tier unlocks
 * and how far away it is. The asymmetry between promotion and demotion is
 * stated explicitly because it is a deliberate safety property, not an
 * implementation detail.
 */
export function TierLadder({
  navUsd,
  daysHeld = 0,
  currentTierId = "T0",
}: {
  navUsd: number;
  daysHeld?: number;
  currentTierId?: TierId;
}) {
  const state = resolveTier(navUsd, daysHeld, currentTierId);
  const curIdx = TIERS.findIndex((t) => t.id === state.current.id);
  const next = state.next;

  return (
    <div className="space-y-4">
      <div className="flex gap-[3px]">
        {TIERS.map((t, i) => {
          const done = i < curIdx;
          const active = i === curIdx;
          return (
            <div key={t.id} className="min-w-0 flex-1">
              <div
                className={cx(
                  "h-1",
                  done && "bg-accent/45",
                  active && "bg-accent",
                  !done && !active && "bg-raised",
                )}
              />
              <div className="mt-1.5 flex items-baseline gap-1">
                <span
                  className={cx(
                    "micro",
                    active ? "text-accent" : done ? "text-muted" : "text-dim",
                  )}
                >
                  {t.id}
                </span>
                <span
                  className={cx("truncate text-[10px]", active ? "text-ink" : "text-dim")}
                >
                  {t.name}
                </span>
              </div>
              <div className="micro mt-1 text-dim">
                {t.maxNavUsd === null
                  ? `$${(t.minNavUsd / 1000).toFixed(0)}k+`
                  : t.minNavUsd >= 1000
                    ? `$${(t.minNavUsd / 1000).toFixed(0)}k`
                    : `$${t.minNavUsd}`}
              </div>
            </div>
          );
        })}
      </div>

      {next && (
        <div className="border-t border-line pt-3">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <Micro>
              PROGRESS TO {next.id} · {next.name.toUpperCase()}
            </Micro>
            <span className="text-[11px] text-muted">
              {state.usdToNext !== null ? (
                <>
                  <Money usd={state.usdToNext} dp={0} /> to go
                </>
              ) : (
                "—"
              )}
            </span>
          </div>

          <div className="h-[3px] w-full bg-raised">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${state.progress * 100}%` }}
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {next.unlocks.map((u) => (
              <span
                key={u}
                className="micro border border-line-bright px-1.5 py-1 text-dim"
              >
                + {u}
              </span>
            ))}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Promotion requires NAV to hold above{" "}
            <span className="tnum text-ink">${next.minNavUsd.toLocaleString()}</span> for{" "}
            {PROMOTION_HOLD_DAYS} consecutive days, so a lucky spike cannot unlock
            leverage. Demotion is immediate on breach — protecting capital should
            not wait for confirmation.
            {state.awaitingPromotion && (
              <span className="text-warn">
                {" "}
                Qualified for {state.implied.id}; {state.daysUntilPromotion}d of hold
                remaining.
              </span>
            )}
          </p>
        </div>
      )}

      <p className="border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
        {state.current.rationale}
      </p>
    </div>
  );
}
