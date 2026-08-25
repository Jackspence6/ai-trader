"use client";

/**
 * The books this desk quotes, and whether their feeds are alive.
 *
 * A bookmaker that has never been configured and a bookmaker whose feed died an
 * hour ago both produce no prices, and they need opposite responses. The health
 * state distinguishes them; the roster below makes the unconfigured ones visible
 * rather than absent, because a book you forgot exists is a book you never add.
 */

import { useEffect, useState } from "react";
import { Panel, Micro, Stat, Tag, cx } from "@/components/ui";
import { HealthBadge } from "@/components/events/badges";
import { durationShort, pct } from "@/lib/events/format";
import type { VenueHealth } from "@/lib/events/types";

/** What the engine ships with, and the state of each integration. Kept here
 *  rather than derived from the feed so a book that is not reporting at all
 *  still appears — the whole point is to show what is missing. */
const ROSTER = [
  {
    id: "sunbet",
    name: "Sunbet",
    kind: "Bookmaker",
    platform: "Kambi",
    status: "integrated" as const,
    note: "Kambi offering API behind a Shape Games front end. 239 pre-match soccer, 209 tennis, 183 American football at last capture.",
  },
  {
    id: "betway_sa",
    name: "Betway SA",
    kind: "Bookmaker",
    platform: "Betradar",
    status: "integrated" as const,
    note: "Board feed proxied through Betway's own origin. Whole board in one request, no auth. Sits behind Akamai — server-side reachability is unproven.",
  },
  {
    id: "polymarket",
    name: "Polymarket",
    kind: "Prediction market",
    platform: "CLOB",
    status: "integrated" as const,
    note: "Fee-aware: taker fees are read live per market rather than from the docs table. Geoblocked from US IPs; South African egress is fine.",
  },
  {
    id: "hollywoodbets",
    name: "Hollywoodbets",
    kind: "Bookmaker",
    platform: "In-house (BET Software)",
    status: "not-integrated" as const,
    note: "Cloudflare and reCAPTCHA confirmed. Plan on the browser network tap, a 30s floor between requests, and backing off on any challenge.",
  },
  {
    id: "supabets",
    name: "Supabets",
    kind: "Bookmaker",
    platform: "WA.Technology",
    status: "not-integrated" as const,
    note: "SPA with JSON endpoints expected. Not yet captured.",
  },
];

export default function BooksPage() {
  const [health, setHealth] = useState<VenueHealth[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch("/api/events/venues/health", { cache: "no-store" });
        const data = await res.json();
        if (!stop) setHealth(Array.isArray(data?.venues) ? data.venues : []);
      } catch {
        if (!stop) setErr(true);
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const byId = new Map((health ?? []).map((h) => [h.venue_id, h]));
  const integrated = ROSTER.filter((r) => r.status === "integrated");
  const reporting = integrated.filter((r) => byId.has(r.id)).length;

  return (
    <div className="space-y-3">
      <Panel label="Coverage" hint="Books and prediction markets">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Integrated" sub={<span className="micro text-dim">parser written and tested</span>}>
            <span className="tnum text-ink">{integrated.length}</span>
          </Stat>
          <Stat label="Reporting" sub={<span className="micro text-dim">engine has heard from them</span>}>
            <span className={cx("tnum", reporting > 0 ? "text-up" : "text-dim")}>
              {reporting}
            </span>
          </Stat>
          <Stat label="Not integrated" sub={<span className="micro text-dim">endpoint not captured</span>}>
            <span className="tnum text-warn">
              {ROSTER.length - integrated.length}
            </span>
          </Stat>
          <Stat label="Books needed to cross" sub={<span className="micro text-dim">two leave a 1.3% gap</span>}>
            <span className="tnum text-muted">3+</span>
          </Stat>
        </div>
        <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
          Public odds endpoints only. No account, login, balance or placement call is
          ever made — this desk reads prices and tells a person what to do with them.
        </p>
      </Panel>

      <Panel label="Roster" flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-line">
                {["Book", "Type", "Platform", "Integration", "Feed", "Last quote", "Errors"].map((h) => (
                  <th key={h} className="px-3 py-2 font-normal">
                    <Micro className="text-dim">{h.toUpperCase()}</Micro>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROSTER.map((r) => {
                const h = byId.get(r.id);
                return (
                  <tr key={r.id} className="border-b border-line/60 align-top">
                    <td className="px-3 py-2.5">
                      <div className="text-ink">{r.name}</div>
                      <div className="mt-0.5 max-w-[380px] text-[10.5px] leading-snug text-dim">
                        {r.note}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{r.kind}</td>
                    <td className="px-3 py-2.5 text-muted">{r.platform}</td>
                    <td className="px-3 py-2.5">
                      {r.status === "integrated" ? (
                        <Tag tone="up">Integrated</Tag>
                      ) : (
                        <Tag tone="warn">Not integrated</Tag>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {h ? (
                        <HealthBadge state={h.state} />
                      ) : (
                        <span className="micro text-dim">
                          {r.status === "integrated" ? "no engine" : "—"}
                        </span>
                      )}
                    </td>
                    <td className="tnum px-3 py-2.5 text-muted">
                      {h?.staleness_s != null ? `${durationShort(h.staleness_s)} ago` : "—"}
                    </td>
                    <td className="tnum px-3 py-2.5 text-muted">
                      {h ? pct(h.error_rate * 100, 1) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {(err || health?.length === 0) && (
        <Panel label="No engine">
          <p className="text-[12px] leading-relaxed text-muted">
            Nothing is reporting feed health, which means the events engine is not
            running against this database. The roster above is the integration state of
            the code, not of a live system — every &ldquo;Integrated&rdquo; book has a
            tested parser and no heartbeat.
          </p>
        </Panel>
      )}
    </div>
  );
}
