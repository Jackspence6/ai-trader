"use client";

/**
 * Component gallery.
 *
 * Every shared primitive in every state, on one page. Not in the navigation:
 * this is a workbench, not a screen.
 *
 * It earns its place because most of this interface's states are ones you
 * cannot reach on demand — a feed going stale, a venue quarantining, a panel
 * with nothing in it because the market is efficient today. Without somewhere
 * to render them deliberately, those states get designed once and then never
 * looked at again, which is exactly how an interface ends up polished in the
 * places you visit and broken in the places you do not.
 */

import { Panel, Micro, Stat, Tag, StatusDot, Meter, Num, Delta } from "@/components/ui";
import {
  Empty,
  LiveNumber,
  LivePulse,
  Sparkline,
  SkeletonBar,
  SkeletonChart,
  SkeletonTable,
} from "@/components/vis";
import { useEffect, useState } from "react";

const SERIES_UP = [12, 14, 13, 17, 16, 19, 18, 22, 21, 25, 24, 28, 31, 30, 34];
const SERIES_DOWN = [34, 32, 33, 29, 30, 27, 26, 22, 24, 20, 19, 17, 15, 16, 12];
const SERIES_FLAT = [20, 21, 20, 22, 21, 20, 21, 22, 21, 20, 21, 20, 22, 21, 20];

export default function GalleryPage() {
  // A slow tick so the live primitives can be seen actually moving rather than
  // just rendered once at a value.
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((n) => n + 1), 2200);
    return () => clearInterval(id);
  }, []);
  const price = 64213.5 + Math.sin(t / 2) * 180;
  const pnl = 1240.25 + Math.cos(t / 3) * 420;

  return (
    <div className="space-y-3">
      <Panel label="Gallery" hint="every shared primitive, every state" right={<LivePulse />}>
        <p className="max-w-3xl text-[12px] leading-relaxed text-muted">
          A workbench for the states that are hard to reach on purpose. If something
          here looks wrong, it looks wrong everywhere.
        </p>
      </Panel>

      {/* ------------------------------------------------------------ empty */}
      <Panel label="Empty states" hint="four reasons a panel has nothing in it" flush>
        <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0 lg:grid-cols-4">
          <Empty
            kind="idle"
            title="NO ARBITRAGE OPEN"
            body="Books are being read and none of them cross. The normal state of an efficient market."
          />
          <Empty kind="waiting" title="LOOKING FOR THE ENGINE" body="Connecting to the scanner." />
          <Empty
            kind="absent"
            title="NOT BUILT"
            body="Placement recording exists in the schema and nowhere else yet."
          />
          <Empty
            kind="fault"
            title="NOTHING IS SCANNING"
            body="No engine and no database. This is a blank instrument, not an empty market."
          />
        </div>
      </Panel>

      {/* -------------------------------------------------------- skeletons */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel label="Loading — table" hint="matches the real row height, so nothing jumps" flush>
          <SkeletonTable rows={5} cols={5} />
        </Panel>
        <Panel label="Loading — chart">
          <SkeletonChart height={180} />
          <div className="mt-3 flex gap-3">
            <SkeletonBar w="30%" />
            <SkeletonBar w="20%" />
            <SkeletonBar w="25%" />
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------------------- live */}
      <Panel label="Live values" hint="digits roll; colour still means direction" right={<LivePulse />}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Mark price" sub={<span className="micro text-dim">BTC · binance</span>}>
            <LiveNumber value={price} prefix="$" dp={2} className="text-[22px]" />
          </Stat>
          <Stat label="Unrealised" sub={<span className="micro text-dim">paper book</span>}>
            <LiveNumber value={pnl} prefix="$" dp={2} tone={pnl >= 0 ? "up" : "down"} className="text-[22px]" />
          </Stat>
          <Stat label="Margin" sub={<span className="micro text-dim">best on the board</span>}>
            <LiveNumber value={1.34} suffix="%" dp={2} tone="up" className="text-[22px]" />
          </Stat>
          <Stat label="Open" sub={<span className="micro text-dim">positions</span>}>
            <LiveNumber value={0} dp={0} tone="muted" className="text-[22px]" />
          </Stat>
        </div>
      </Panel>

      {/* -------------------------------------------------------- sparkline */}
      <Panel label="Series" hint="area + last point; gradient is what makes it read as data">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            ["RISING", SERIES_UP, "up"],
            ["FALLING", SERIES_DOWN, "down"],
            ["FLAT", SERIES_FLAT, "accent"],
          ].map(([label, pts, tone]) => (
            <div key={label as string}>
              <Micro className="mb-2 block text-dim">{label as string}</Micro>
              <Sparkline points={pts as number[]} tone={tone as "up" | "down" | "accent"} height={54} />
            </div>
          ))}
        </div>
      </Panel>

      {/* ------------------------------------------------------------- chips */}
      <Panel label="Status vocabulary" hint="one word, one meaning, everywhere">
        <div className="flex flex-wrap items-center gap-1.5">
          {(["neutral", "up", "down", "warn", "accent"] as const).map((tone) => (
            <Tag key={tone} tone={tone}>
              {tone.toUpperCase()}
            </Tag>
          ))}
          <span className="mx-2 h-4 w-px bg-line" />
          {(["ok", "warn", "bad", "idle"] as const).map((s) => (
            <span key={s} className="micro inline-flex items-center gap-1.5 text-muted">
              <StatusDot state={s} pulse={s === "ok"} />
              {s.toUpperCase()}
            </span>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Meter used={12} limit={40} label="Exposure" unit="$" />
          <Meter used={26} limit={40} label="Approaching" unit="$" />
          <Meter used={38} limit={40} label="At the limit" unit="$" />
        </div>
      </Panel>

      {/* --------------------------------------------------------- controls */}
      <Panel label="Controls" hint="hover, focus and disabled are states, not afterthoughts">
        <div className="flex flex-wrap items-center gap-2">
          <button className="interactive micro border border-line-bright px-2.5 py-1.5 text-muted hover:text-ink">
            DEFAULT
          </button>
          <button className="interactive micro border border-accent/50 bg-accent/10 px-2.5 py-1.5 text-accent hover:bg-accent/20">
            PRIMARY
          </button>
          <button className="interactive micro border border-down/50 bg-down/10 px-2.5 py-1.5 text-down hover:bg-down/20">
            DESTRUCTIVE
          </button>
          <button disabled className="interactive micro border border-line-bright px-2.5 py-1.5 text-muted">
            DISABLED
          </button>
          <input
            defaultValue="10000"
            className="tnum interactive w-32 border border-line-bright bg-panel-2 px-2 py-1.5 text-right text-[12px] text-ink outline-none focus:border-accent/60"
          />
        </div>
        <p className="mt-3 text-[11px] text-dim">
          Tab through these — every control takes a visible accent ring from the global
          focus-visible rule, including the ones that are not buttons.
        </p>
      </Panel>

      {/* ---------------------------------------------------------- numerics */}
      <Panel label="Numerics" hint="fractional part dimmed so columns scan">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Large">
            <Num value={1284531.24} prefix="$" className="text-[22px]" />
          </Stat>
          <Stat label="Delta up">
            <Delta value={0.0412} />
          </Stat>
          <Stat label="Delta down">
            <Delta value={-0.0187} />
          </Stat>
          <Stat label="Zero">
            <Num value={0} prefix="$" className="text-[22px]" />
          </Stat>
        </div>
      </Panel>
    </div>
  );
}
