"use client";

/**
 * Command Center — the at-a-glance screen.
 *
 * Everything here is real. Where there is no data yet — no capital, no fills —
 * it reads zero and says why, rather than showing a plausible number. A trading
 * dashboard that invents figures is worse than no dashboard, because invented
 * numbers look exactly as convincing as real ones.
 *
 * The screen is organised around the two books. Capital is split into a crypto
 * account and a forex account, and the whole point of holding both is that they
 * are separable — so the layout keeps them visually distinct (crypto in the
 * indigo accent, forex in the teal) everywhere the two appear together.
 */

import Link from "next/link";
import { useLive } from "@/lib/live";
import { Money } from "@/lib/currency";
import { resolveTier } from "@/lib/calc/tiers";
import { REJECTION_LABELS } from "@/lib/calc/gate";
import type { CapitalEvent, FundAccount } from "@/lib/fund/ledger";
import type { ScoredOpportunity } from "@/lib/engine/scanner";
import type { MarketSnapshot } from "@/lib/market/types";
import { TierLadder } from "@/components/ladder";
import { cx, Delta, Micro, Num, Panel, Stat, StatusDot, Tag } from "@/components/ui";

/* ------------------------------------------------------------- response types */

type NavView = {
  navUsd: number;
  netContributedUsd: number;
  performanceIndex: number;
  twrPct: number;
  returnOnCapitalPct: number | null;
  funded: boolean;
  nature: "simulated" | "real" | "mixed" | "none";
};
type Pnl = { totalUsd: number; realisedUsd: number; unrealisedUsd: number; fundingUsd: number };
type AccountView = {
  account: FundAccount;
  label: string;
  note: string;
  nav: NavView;
  pnl: Pnl;
  openPositions: number;
  unpriced: string[];
};
type FundResponse = {
  fund: { name: string; ownership: string; decisionMaker: string };
  nav: NavView;
  pnl: Pnl;
  accounts: AccountView[];
  rates: { source: "live" | "cached" | "reference"; zarPerUsd: number | null };
  events: CapitalEvent[];
};

type SignalsResponse = {
  opportunities: ScoredOpportunity[];
};

type FxDir = "long" | "short" | "flat";
type FxSignal = {
  symbol: string;
  rate: number;
  stale: boolean;
  carry: { direction: FxDir; netCarryApr: number; viable: boolean; note: string };
  trend: { direction: FxDir; strengthPct: number; annualisedVol: number | null; engaged: boolean };
};
type ForexResponse = {
  asOf: string | null;
  signals: FxSignal[];
  viableCarryCount: number;
  engagedTrendCount: number;
};

type BasisSignal = {
  asset: string;
  futureSymbol: string;
  expiryMs: number;
  spot: number;
  future: number;
  result: {
    basisPct: number;
    daysToExpiry: number;
    annualisedBasisApr: number;
    direction: "cash-and-carry" | "reverse-carry" | "none";
    netEdgeBps: number;
    viable: boolean;
  };
};
type BasisResponse = { signals: BasisSignal[]; viableCount: number };

/* ------------------------------------------------------- asset-class identity */

const CLASS: Record<FundAccount, { text: string; border: string; bg: string; dot: string }> = {
  crypto: { text: "text-accent", border: "border-accent/50", bg: "bg-accent/[0.06]", dot: "bg-accent" },
  forex: { text: "text-fx", border: "border-fx/50", bg: "bg-fx/[0.06]", dot: "bg-fx" },
};

/* --------------------------------------------------------------- the screen */

export default function CommandCenter() {
  const fundData = useLive<FundResponse>("/api/fund", 20_000);
  const markets = useLive<MarketSnapshot>("/api/markets", 15_000);
  const signals = useLive<SignalsResponse>("/api/signals", 25_000);
  const forex = useLive<ForexResponse>("/api/forex", 60_000);
  const basis = useLive<BasisResponse>("/api/basis", 60_000);
  const halt = useLive<{ state: { halted: boolean } }>("/api/halt", 20_000);

  const fund = fundData.data;
  const nav = fund?.nav.navUsd ?? 0;
  const tier = resolveTier(nav, 0, "T0").current;
  const halted = halt.data?.state.halted ?? false;

  const cryptoOpps = signals.data?.opportunities ?? [];
  const fxSignals = forex.data?.signals ?? [];

  // Would-take counts, per class, for the scanner strip.
  const cryptoViable = cryptoOpps.filter((o) => o.wouldTake).length;
  const fxViable = forex.data?.viableCarryCount ?? 0;
  const bestCrypto = cryptoOpps.filter((o) => o.wouldTake)[0] ?? cryptoOpps[0] ?? null;

  const venues = markets.data ? [...new Set(markets.data.quotes.map((q) => q.venue))] : [];
  const venuesDown = markets.data?.errors.length ?? 0;

  return (
    <div className="space-y-3 p-3">
      <StatusStrip
        nature={fund?.nav.nature ?? "none"}
        halted={halted}
        tierId={tier.id}
        tierName={tier.name}
        rateSource={fund?.rates.source}
        zarPerUsd={fund?.rates.zarPerUsd ?? null}
        age={fundData.ageSeconds}
        status={fundData.status}
      />

      {/* ============================================================ hero */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.5fr_1fr]">
        <Panel
          label="FUND — NET ASSET VALUE"
          hint="CRYPTO + FOREX · DERIVED FROM THE LEDGER"
          right={
            <div className="flex items-center gap-1.5">
              <Tag>{fund?.fund.name ?? "—"}</Tag>
              <Tag tone={(fund?.nav.twrPct ?? 0) >= 0 ? "up" : "down"}>
                TWR {(fund?.nav.twrPct ?? 0) >= 0 ? "+" : ""}
                {((fund?.nav.twrPct ?? 0) * 100).toFixed(3)}%
              </Tag>
            </div>
          }
        >
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <span className="text-[38px] leading-none tracking-tight text-ink">
                <Money usd={nav} />
              </span>
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                <Micro>INVESTED</Micro>
                <span className="text-muted">
                  <Money usd={fund?.nav.netContributedUsd ?? 0} />
                </span>
                <span className="text-dim">·</span>
                <Micro>P&amp;L</Micro>
                <Delta value={fund?.pnl.totalUsd ?? 0} prefix="$" />
                {fund?.rates.zarPerUsd && (
                  <>
                    <span className="text-dim">·</span>
                    <span className="micro text-dim">
                      R{(nav * fund.rates.zarPerUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Stat label="TIER" sub={<span className="text-dim">{tier.name}</span>}>
                <span className="text-accent">{tier.id}</span>
              </Stat>
              <Stat label="INDEX" sub={<span className="text-dim">1.0 at inception</span>}>
                <span className="tnum">{(fund?.nav.performanceIndex ?? 1).toFixed(4)}</span>
              </Stat>
              <Stat label="LIVE STRATEGIES" sub={<span className="text-dim">at this tier</span>}>
                <span className="text-ink text-[13px]">
                  {tier.liveStrategies.length > 0 ? tier.liveStrategies.join(" ") : "shadow"}
                </span>
              </Stat>
              <Stat label="OPEN" sub={<span className="text-dim">positions</span>}>
                <span className="tnum">
                  {fund?.accounts.reduce((a, x) => a + x.openPositions, 0) ?? 0}
                </span>
              </Stat>
            </div>
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <TierLadder navUsd={nav} />
          </div>
        </Panel>

        {/* -------------------------------------------------- the two books */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
          {(fund?.accounts ?? PLACEHOLDER_ACCOUNTS).map((a) => (
            <AccountCard
              key={a.account}
              a={a}
              zarPerUsd={fund?.rates.zarPerUsd ?? null}
              viableSignals={a.account === "crypto" ? cryptoViable : fxViable}
            />
          ))}
        </div>
      </div>

      {/* ==================================================== scanner strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MiniStat label="SCANNING" sub="crypto + forex" value={cryptoOpps.length + fxSignals.length} />
        <MiniStat
          label="WOULD TAKE"
          sub="clears every gate"
          value={cryptoViable + fxViable}
          tone={cryptoViable + fxViable > 0 ? "up" : "muted"}
        />
        <Panel>
          <Stat
            label="BEST CRYPTO EDGE"
            sub={bestCrypto && <span className="text-dim">{bestCrypto.asset} · {bestCrypto.strategy}</span>}
          >
            {bestCrypto ? (
              <span className={cx("tnum text-[22px]", bestCrypto.netBps >= 0 ? "text-up" : "text-down")}>
                {bestCrypto.netBps >= 0 ? "+" : ""}
                {bestCrypto.netBps.toFixed(0)}bp
              </span>
            ) : (
              <span className="text-[22px] text-dim">—</span>
            )}
          </Stat>
        </Panel>
        <MiniStat
          label="FX SIGNALS ENGAGED"
          sub="carry + trend"
          value={fxViable + (forex.data?.engagedTrendCount ?? 0)}
          tone="fx"
        />
      </div>

      {/* ==================================================== live signals */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <CryptoSignals opps={cryptoOpps} connecting={signals.status === "connecting"} />
        <ForexSignals signals={fxSignals} connecting={forex.status === "connecting"} />
      </div>

      <BasisPanel signals={basis.data?.signals ?? []} connecting={basis.status === "connecting"} />

      {/* ==================================================== market + health */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
        <MarketMovers snapshot={markets.data} />
        <VenueHealth venues={venues} down={venuesDown} snapshot={markets.data} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- status strip */

function StatusStrip({
  nature,
  halted,
  tierId,
  tierName,
  rateSource,
  zarPerUsd,
  age,
  status,
}: {
  nature: NavView["nature"];
  halted: boolean;
  tierId: string;
  tierName: string;
  rateSource?: "live" | "cached" | "reference";
  zarPerUsd: number | null;
  age: number;
  status: "connecting" | "live" | "stale" | "error";
}) {
  const natureTag =
    nature === "real"
      ? { tone: "warn" as const, text: "REAL CAPITAL" }
      : nature === "mixed"
        ? { tone: "down" as const, text: "MIXED LEDGER" }
        : nature === "none"
          ? { tone: "accent" as const, text: "NO CAPITAL" }
          : { tone: "accent" as const, text: "PAPER · LIVE DATA" };

  return (
    <div className="flex flex-wrap items-center gap-2 border border-line bg-panel/60 px-3 py-2">
      <Tag tone={natureTag.tone}>{natureTag.text}</Tag>
      {halted ? (
        <Tag tone="down">GLOBAL HALT</Tag>
      ) : (
        <span className="flex items-center gap-1.5">
          <StatusDot state="ok" pulse />
          <span className="micro text-muted">TRADING · {tierId} {tierName.toUpperCase()}</span>
        </span>
      )}
      <span className="micro text-dim">
        Every price, rate and P&amp;L is live market data. Fills are paper — no
        money at a broker.
      </span>
      <div className="ml-auto flex items-center gap-3">
        {rateSource && zarPerUsd && (
          <span className="micro text-dim" title={`FX rate source: ${rateSource}`}>
            1 USD = R{zarPerUsd.toFixed(2)}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <StatusDot
            state={status === "live" ? "ok" : status === "error" ? "bad" : status === "stale" ? "warn" : "idle"}
          />
          <span className="micro tnum text-dim">{age}s</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- account card */

const PLACEHOLDER_ACCOUNTS: AccountView[] = [
  { account: "crypto", label: "Crypto", note: "", nav: emptyNav(), pnl: emptyPnl(), openPositions: 0, unpriced: [] },
  { account: "forex", label: "Forex", note: "", nav: emptyNav(), pnl: emptyPnl(), openPositions: 0, unpriced: [] },
];
function emptyNav(): NavView {
  return { navUsd: 0, netContributedUsd: 0, performanceIndex: 1, twrPct: 0, returnOnCapitalPct: null, funded: false, nature: "none" };
}
function emptyPnl(): Pnl {
  return { totalUsd: 0, realisedUsd: 0, unrealisedUsd: 0, fundingUsd: 0 };
}

function AccountCard({
  a,
  zarPerUsd,
  viableSignals,
}: {
  a: AccountView;
  zarPerUsd: number | null;
  viableSignals: number;
}) {
  const s = CLASS[a.account];
  const roc = a.nav.returnOnCapitalPct;

  return (
    <div className={cx("ticked relative border border-line border-l-2 bg-panel/70", s.border)}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={cx("inline-block size-2", s.dot)} />
        <span className={cx("text-[12.5px] font-medium tracking-wide", s.text)}>
          {a.label.toUpperCase()}
        </span>
        <span className="micro ml-auto text-dim">
          {a.openPositions} open · {viableSignals} signal{viableSignals === 1 ? "" : "s"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 p-3">
        <div className="min-w-0">
          <Micro className="mb-1.5">BALANCE</Micro>
          <div className="text-[17px] leading-none text-ink">
            <Money usd={a.nav.navUsd} />
          </div>
          {zarPerUsd && (
            <div className="micro mt-1 text-dim">
              R{(a.nav.navUsd * zarPerUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <Micro className="mb-1.5">INVESTED</Micro>
          <div className="text-[17px] leading-none text-muted">
            <Money usd={a.nav.netContributedUsd} />
          </div>
        </div>
        <div className="min-w-0">
          <Micro className="mb-1.5">P&amp;L</Micro>
          <div className="text-[17px] leading-none">
            <Delta value={a.pnl.totalUsd} prefix="$" />
          </div>
          <div className="micro mt-1 text-dim">
            {roc === null ? "—" : `${roc >= 0 ? "+" : ""}${(roc * 100).toFixed(2)}%`}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- mini stat */

function MiniStat({
  label,
  sub,
  value,
  tone = "ink",
}: {
  label: string;
  sub: string;
  value: number;
  tone?: "ink" | "up" | "muted" | "fx";
}) {
  const c = tone === "up" ? "text-up" : tone === "muted" ? "text-muted" : tone === "fx" ? "text-fx" : "text-ink";
  return (
    <Panel>
      <Stat label={label} sub={<span className="text-dim">{sub}</span>}>
        <span className={cx("tnum text-[22px]", c)}>{value}</span>
      </Stat>
    </Panel>
  );
}

/* ------------------------------------------------------------ crypto signals */

function CryptoSignals({ opps, connecting }: { opps: ScoredOpportunity[]; connecting: boolean }) {
  return (
    <Panel
      label="CRYPTO SIGNALS"
      hint="FUNDING CARRY · CROSS-VENUE SPREAD"
      right={
        <span className="flex items-center gap-2">
          <span className="inline-block size-2 bg-accent" />
          <Link href="/signals" className="micro text-accent hover:underline">FEED →</Link>
        </span>
      }
      flush
    >
      {opps.length === 0 ? (
        <div className="p-4 text-[12px] text-dim">
          {connecting ? "Scanning live markets…" : "No opportunities scored in the latest scan."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line">
                <SigTh>ASSET</SigTh>
                <SigTh>ROUTE</SigTh>
                <SigTh right>NET EDGE</SigTh>
                <SigTh right>APR</SigTh>
                <SigTh>DECISION</SigTh>
              </tr>
            </thead>
            <tbody>
              {opps.slice(0, 6).map((o) => (
                <tr key={o.id} className="border-b border-line/60 hover:bg-raised/40">
                  <SigTd>
                    <span className="text-ink">{o.asset}</span>
                    <span className="micro ml-2 text-accent" title={o.strategyName}>{o.strategy}</span>
                  </SigTd>
                  <SigTd><span className="text-dim">{o.route}</span></SigTd>
                  <SigTd right>
                    <span className={cx("tnum", o.netBps > 0 ? "text-up" : o.netBps < 0 ? "text-down" : "text-muted")}>
                      {o.netBps > 0 ? "+" : ""}{o.netBps.toFixed(1)}bp
                    </span>
                  </SigTd>
                  <SigTd right>
                    {o.netApr === null ? (
                      <span className="text-dim">—</span>
                    ) : (
                      <span className={cx("tnum", o.netApr >= 0 ? "text-up" : "text-down")}>
                        {(o.netApr * 100).toFixed(1)}%
                      </span>
                    )}
                  </SigTd>
                  <SigTd>
                    {o.wouldTake ? (
                      <Tag tone="up">TAKE</Tag>
                    ) : (
                      <span className="text-dim" title={o.rejectionDetail ?? undefined}>
                        {o.rejectionCode ? REJECTION_LABELS[o.rejectionCode] : "—"}
                      </span>
                    )}
                  </SigTd>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- forex signals */

function DirTag({ dir, viable }: { dir: FxDir; viable: boolean }) {
  if (dir === "flat" || !viable) return <span className="micro text-dim">FLAT</span>;
  return <span className={cx("micro", dir === "long" ? "text-up" : "text-down")}>{dir === "long" ? "LONG" : "SHORT"}</span>;
}

function ForexSignals({ signals, connecting }: { signals: FxSignal[]; connecting: boolean }) {
  return (
    <Panel
      label="FOREX SIGNALS"
      hint="INTEREST-RATE CARRY · TREND"
      right={
        <span className="flex items-center gap-2">
          <span className="inline-block size-2 bg-fx" />
          <Link href="/allocation" className="micro text-fx hover:underline">DETAIL →</Link>
        </span>
      }
      flush
    >
      {signals.length === 0 ? (
        <div className="p-4 text-[12px] text-dim">
          {connecting ? "Scoring FX pairs…" : "Forex feed unavailable right now."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line">
                <SigTh>PAIR</SigTh>
                <SigTh right>RATE</SigTh>
                <SigTh>CARRY</SigTh>
                <SigTh right>NET APR</SigTh>
                <SigTh>TREND</SigTh>
                <SigTh right>VOL</SigTh>
              </tr>
            </thead>
            <tbody>
              {signals.slice(0, 6).map((s) => (
                <tr key={s.symbol} className="border-b border-line/60 hover:bg-raised/40">
                  <SigTd>
                    <span className="text-ink">{s.symbol}</span>
                    {s.stale && <span className="micro ml-1 text-warn">STALE</span>}
                  </SigTd>
                  <SigTd right><span className="tnum text-muted">{s.rate.toFixed(s.rate > 20 ? 2 : 4)}</span></SigTd>
                  <SigTd><DirTag dir={s.carry.direction} viable={s.carry.viable} /></SigTd>
                  <SigTd right>
                    <span className={cx("tnum", s.carry.viable ? "text-up" : "text-dim")}>
                      {s.carry.viable ? `${(s.carry.netCarryApr * 100).toFixed(2)}%` : "—"}
                    </span>
                  </SigTd>
                  <SigTd>
                    {s.trend.engaged ? (
                      <span className={cx("micro", s.trend.direction === "long" ? "text-up" : "text-down")}>
                        {s.trend.direction === "long" ? "UP" : "DOWN"}
                      </span>
                    ) : (
                      <span className="micro text-dim">—</span>
                    )}
                  </SigTd>
                  <SigTd right>
                    <span className="tnum text-dim">
                      {s.trend.annualisedVol !== null ? `${(s.trend.annualisedVol * 100).toFixed(0)}%` : "—"}
                    </span>
                  </SigTd>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* --------------------------------------------------------------- basis panel */

function BasisPanel({ signals, connecting }: { signals: BasisSignal[]; connecting: boolean }) {
  return (
    <Panel
      label="CASH & CARRY BASIS"
      hint="SPOT vs QUARTERLY FUTURE · CONVERGES AT EXPIRY"
      right={<Tag tone="accent">SCORED · EXECUTION NEXT</Tag>}
      flush
    >
      {signals.length === 0 ? (
        <div className="p-4 text-[12px] text-dim">
          {connecting ? "Reading dated futures…" : "No quarterly futures basis available right now."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line">
                <SigTh>ASSET</SigTh>
                <SigTh>EXPIRY</SigTh>
                <SigTh right>DAYS</SigTh>
                <SigTh right>BASIS</SigTh>
                <SigTh right>ANNUALISED</SigTh>
                <SigTh right>NET EDGE</SigTh>
                <SigTh>TRADE</SigTh>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.futureSymbol} className="border-b border-line/60">
                  <SigTd><span className="text-ink">{s.asset}</span></SigTd>
                  <SigTd>
                    <span className="tnum text-dim">
                      {new Date(s.expiryMs).toISOString().slice(0, 10)}
                    </span>
                  </SigTd>
                  <SigTd right><span className="tnum text-dim">{s.result.daysToExpiry.toFixed(0)}</span></SigTd>
                  <SigTd right>
                    <span className={cx("tnum", s.result.basisPct >= 0 ? "text-up" : "text-down")}>
                      {s.result.basisPct >= 0 ? "+" : ""}{(s.result.basisPct * 100).toFixed(2)}%
                    </span>
                  </SigTd>
                  <SigTd right>
                    <span className={cx("tnum", s.result.annualisedBasisApr >= 0 ? "text-up" : "text-down")}>
                      {(s.result.annualisedBasisApr * 100).toFixed(1)}%
                    </span>
                  </SigTd>
                  <SigTd right>
                    <span className={cx("tnum", s.result.netEdgeBps > 0 ? "text-up" : "text-dim")}>
                      {s.result.netEdgeBps > 0 ? "+" : ""}{s.result.netEdgeBps.toFixed(1)}bp
                    </span>
                  </SigTd>
                  <SigTd>
                    {s.result.viable ? (
                      <Tag tone="up">{s.result.direction === "cash-and-carry" ? "BUY SPOT / SHORT FUT" : "SHORT SPOT / LONG FUT"}</Tag>
                    ) : (
                      <span className="text-dim">edge below cost</span>
                    )}
                  </SigTd>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- market movers */

function MarketMovers({ snapshot }: { snapshot: MarketSnapshot | null }) {
  // One spot quote per asset, sorted by 24h move. This is the crypto tape.
  const bySeen = new Map<string, { asset: string; change: number; last: number; fundingApr: number | null }>();
  for (const q of snapshot?.quotes ?? []) {
    if (bySeen.has(q.asset)) continue;
    if (q.last <= 0) continue;
    const perp = snapshot!.quotes.find((x) => x.asset === q.asset && x.fundingApr !== undefined);
    bySeen.set(q.asset, {
      asset: q.asset,
      change: q.change24hPct,
      last: q.last,
      fundingApr: perp?.fundingApr ?? null,
    });
  }
  const rows = [...bySeen.values()].sort((a, b) => b.change - a.change);

  return (
    <Panel
      label="MARKET TAPE"
      hint="24H MOVE · FUNDING · LIVE"
      right={<Link href="/markets" className="micro text-accent hover:underline">MARKETS →</Link>}
      flush
    >
      {rows.length === 0 ? (
        <div className="p-4 text-[12px] text-dim">Connecting to venues…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line">
                <SigTh>ASSET</SigTh>
                <SigTh right>LAST</SigTh>
                <SigTh right>24H</SigTh>
                <SigTh right>FUNDING APR</SigTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.asset} className="border-b border-line/60">
                  <SigTd><span className="text-ink">{r.asset}</span></SigTd>
                  <SigTd right>
                    <Num value={r.last} dp={r.last < 10 ? 4 : 2} prefix="$" className="text-muted" />
                  </SigTd>
                  <SigTd right><Delta value={r.change} suffix="%" /></SigTd>
                  <SigTd right>
                    {r.fundingApr === null ? (
                      <span className="text-dim">—</span>
                    ) : (
                      <span className={cx("tnum", r.fundingApr >= 0 ? "text-up" : "text-down")}>
                        {r.fundingApr >= 0 ? "+" : ""}{(r.fundingApr * 100).toFixed(1)}%
                      </span>
                    )}
                  </SigTd>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------- venue health */

function VenueHealth({
  venues,
  down,
  snapshot,
}: {
  venues: string[];
  down: number;
  snapshot: MarketSnapshot | null;
}) {
  return (
    <Panel label="VENUE HEALTH" hint="PUBLIC MARKET FEEDS">
      {venues.length === 0 && !snapshot ? (
        <div className="text-[11px] text-dim">Connecting to venues…</div>
      ) : (
        <ul className="space-y-2.5">
          {venues.map((v) => {
            const n = snapshot!.quotes.filter((q) => q.venue === v).length;
            return (
              <li key={v} className="flex items-center gap-2.5">
                <StatusDot state="ok" pulse />
                <span className="flex-1 text-[12.5px] text-ink">{v}</span>
                <span className="micro text-dim">{n} markets</span>
              </li>
            );
          })}
          <li className="flex items-center gap-2.5">
            <StatusDot state="ok" pulse />
            <span className="flex-1 text-[12.5px] text-fx">Frankfurter · ECB</span>
            <span className="micro text-dim">FX fixes</span>
          </li>
          {snapshot?.errors.map((e) => (
            <li key={e.venue} className="flex items-center gap-2.5">
              <StatusDot state="bad" />
              <span className="flex-1 text-[12.5px] text-ink">{e.venue}</span>
              <span className="micro text-down">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-dim">
        {down > 0
          ? `${down} venue feed${down === 1 ? "" : "s"} degraded — a down venue is data, not an outage. Its markets drop out of scoring until it returns.`
          : "Public price feeds only. No API credentials are configured, so nothing here can place a live order or read a broker balance."}
      </p>
    </Panel>
  );
}

/* ----------------------------------------------------------------- table cells */

function SigTh({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={cx("micro whitespace-nowrap px-3 py-2 font-normal text-dim", right ? "text-right" : "text-left")}>
      {children}
    </th>
  );
}
function SigTd({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td className={cx("whitespace-nowrap px-3 py-2 text-muted", right ? "text-right" : "text-left")}>
      {children}
    </td>
  );
}
