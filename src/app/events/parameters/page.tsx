"use client";

/**
 * The dials this desk scans under, and whether it is wired up at all.
 *
 * Read-only by design in this phase. Everything here is set on the machine
 * running the engine, not from a browser: a threshold that can be changed from a
 * page anyone can reach is a threshold that can be changed by anyone who reaches
 * the page, and this desk's own charter is that no bookmaker order is ever placed
 * automatically. Showing the values without offering to edit them is the honest
 * version of that.
 */

import { useEffect, useState } from "react";
import { Panel, Micro, Stat, Tag, StatusDot, cx } from "@/components/ui";
import { zar, pct } from "@/lib/events/format";

type Status = {
  database_url_set?: boolean;
  admin_token_set?: boolean;
  cron_secret_set?: boolean;
  schema_migrated?: boolean;
  counts?: Record<string, number>;
  error?: string;
};

type Config = {
  source?: string;
  engine?: Record<string, number>;
};

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1">
        <StatusDot state={ok ? "ok" : "bad"} />
      </span>
      <span className="min-w-0">
        <span className={cx("block text-[12px]", ok ? "text-ink" : "text-down")}>{label}</span>
        <span className="block text-[10.5px] leading-snug text-dim">{detail}</span>
      </span>
    </div>
  );
}

export default function EventsParametersPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    void (async () => {
      const [s, c] = await Promise.allSettled([
        fetch("/api/events/status", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/events/config", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (s.status === "fulfilled") setStatus(s.value);
      if (c.status === "fulfilled") setConfig(c.value);
    })();
  }, []);

  const eng = config?.engine ?? {};
  const counts = status?.counts ?? {};

  return (
    <div className="space-y-3">
      <Panel label="Wiring" hint="first stop when the board looks empty">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Check
            ok={Boolean(status?.database_url_set)}
            label="Database reachable"
            detail="DATABASE_URL points at the Postgres the engine writes"
          />
          <Check
            ok={Boolean(status?.schema_migrated)}
            label="Schema migrated"
            detail="the events schema exists and carries the opportunity tables"
          />
          <Check
            ok={Boolean(status?.admin_token_set)}
            label="Admin token set"
            detail="gates migrations and manual scans — never defaults open"
          />
          <Check
            ok={Boolean(status?.cron_secret_set)}
            label="Scan secret set"
            detail="the scheduled scan authenticates with it"
          />
        </div>
        {status?.error && (
          <p className="mt-3 border border-down/40 bg-down/[0.07] px-2.5 py-2 text-[11px] text-down">
            {status.error}
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-4">
          <Stat label="Opportunities recorded">
            <span className="tnum text-ink">{counts.opportunities ?? 0}</span>
          </Stat>
          <Stat label="Open now">
            <span className="tnum text-ink">{counts.active ?? 0}</span>
          </Stat>
          <Stat label="Odds snapshots">
            <span className="tnum text-muted">{counts.odds_snapshots ?? 0}</span>
          </Stat>
          <Stat label="Placements recorded">
            <span className="tnum text-muted">{counts.placements ?? 0}</span>
          </Stat>
        </div>
      </Panel>

      <Panel
        label="Scan thresholds"
        hint="set where the engine runs"
        right={<Tag tone="neutral">READ ONLY</Tag>}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Minimum margin" sub={<span className="micro text-dim">below this, not shown</span>}>
            <span className="tnum text-ink">{pct(eng.min_margin_pct ?? 0)}</span>
          </Stat>
          <Stat label="Minimum executable" sub={<span className="micro text-dim">per leg</span>}>
            <span className="tnum text-ink">{zar(eng.min_executable_zar ?? 0)}</span>
          </Stat>
          <Stat label="Default stake" sub={<span className="micro text-dim">the plan sizes from this</span>}>
            <span className="tnum text-ink">{zar(eng.total_stake_default_zar ?? 0)}</span>
          </Stat>
          <Stat label="Markets per scan">
            <span className="tnum text-muted">{eng.max_markets_per_scan ?? "—"}</span>
          </Stat>
          <Stat label="Slippage allowance" sub={<span className="micro text-dim">basis points</span>}>
            <span className="tnum text-muted">{eng.slippage_bps ?? "—"}</span>
          </Stat>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          These are environment variables on the machine running the engine. Changing a
          scan threshold from a browser would mean the number that decides what counts as
          an opportunity can be moved by whoever has the page open — so it cannot be.
        </p>
      </Panel>

      <Panel label="Conduct" hint="what this desk will and will not do">
        <ul className="space-y-2 text-[11.5px] leading-relaxed text-muted">
          <li>
            <b className="text-ink">No automated placement.</b> The engine reads public
            odds and produces a stake plan. A person places every bet.
          </li>
          <li>
            <b className="text-ink">Public endpoints only.</b> No login, account, balance
            or bet-placement call is ever made against a bookmaker.
          </li>
          <li>
            <b className="text-ink">One account per person per book.</b> Promotional terms
            are one per person, household and IP, and no amount of expected value changes
            that.
          </li>
          <li>
            <b className="text-ink">Respectful pacing.</b> A per-book minimum interval with
            jitter, one believable user agent, and backing off rather than escalating when
            a book pushes back. No CAPTCHA is ever circumvented.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
