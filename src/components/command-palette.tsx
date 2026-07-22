"use client";

/**
 * ⌘K command palette — the keyboard front door to every screen.
 *
 * DESIGN.md §8 specifies "⌘K command palette for everything"; this is that.
 * Built by hand rather than on cmdk: the whole requirement is a filtered list
 * with roving selection, and a dependency would bring its own styling
 * opinions into a design language that is entirely bespoke.
 *
 * Matching is subsequence-based ("trs" hits "Treasury") with a score that
 * prefers word starts and consecutive runs, so the top result tracks what an
 * operator most plausibly meant. Matches are underlined in place — showing
 * *why* something matched is what makes fuzzy search feel precise instead of
 * spooky.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALL_NAV_ITEMS, navIndex } from "@/lib/nav";
import { NavIcon } from "./nav-icons";
import { cx } from "./ui";

type Command = {
  id: string;
  title: string;
  hint: string;
  section: "SCREENS" | "ACTIONS";
  icon?: string;
  index?: string;
  /** Extra text the matcher may hit (aliases, href). */
  haystack: string;
  run: () => void | Promise<void>;
};

type Scored = { cmd: Command; score: number; positions: number[] };

/**
 * Subsequence match of `query` in `text`, scored. Returns null when the query
 * is not a subsequence. Higher is better: word-start hits and consecutive
 * runs score up, gaps score down.
 */
function fuzzy(query: string, text: string): { score: number; positions: number[] } | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    const wordStart = idx === 0 || t[idx - 1] === " " || t[idx - 1] === "-";
    const consecutive = positions.length > 0 && idx === positions[positions.length - 1] + 1;
    score += 1 + (wordStart ? 3 : 0) + (consecutive ? 2 : 0) - (idx - ti) * 0.05;
    positions.push(idx);
    ti = idx + 1;
  }
  return { score, positions };
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (positions.length === 0) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {text.split("").map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-accent underline decoration-accent/50 underline-offset-2">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // The panel unmounts when closed, so every open starts from clean state —
  // no reset effect, and autoFocus lands on the input natively.
  if (!open) return null;
  return <PaletteOpen onClose={onClose} />;
}

function PaletteOpen({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQueryState] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Selection follows the query: typing re-ranks, so the cursor returns to
  // the top hit. Done in the event handler rather than an effect.
  const setQuery = (q: string) => {
    setQueryState(q);
    setSel(0);
  };

  const commands = useMemo<Command[]>(() => {
    const screens: Command[] = ALL_NAV_ITEMS.map((item) => ({
      id: `nav:${item.key}`,
      title: item.label,
      hint: item.hint,
      section: "SCREENS",
      icon: item.icon,
      index: navIndex(item),
      haystack: `${item.label} ${item.href} ${(item.aliases ?? []).join(" ")}`,
      run: () => router.push(item.href),
    }));
    const actions: Command[] = [
      {
        id: "act:halt",
        title: "Halt trading",
        hint: "Engage the kill switch — cancel resting orders everywhere",
        section: "ACTIONS",
        icon: "risk",
        haystack: "halt trading kill switch stop emergency",
        run: async () => {
          await fetch("/api/halt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "halt", reason: "Halted from the command palette" }),
          });
          router.push("/risk");
        },
      },
      {
        id: "act:resume",
        title: "Resume trading",
        hint: "Clear the halt and let the engine trade again",
        section: "ACTIONS",
        icon: "signals",
        haystack: "resume trading unhalt restart go",
        run: async () => {
          await fetch("/api/halt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "resume", reason: "Resumed from the command palette" }),
          });
        },
      },
    ];
    return [...screens, ...actions];
  }, [router]);

  const results = useMemo<Scored[]>(() => {
    const q = query.trim();
    if (!q) {
      return commands.map((cmd) => ({ cmd, score: 0, positions: [] }));
    }
    // A bare number jumps to that screen: "7" → item 07. The rail numbers
    // items for exactly this reason.
    if (/^\d{1,2}$/.test(q)) {
      const n = parseInt(q, 10);
      const item = ALL_NAV_ITEMS[n - 1];
      if (item) {
        const cmd = commands.find((c) => c.id === `nav:${item.key}`);
        if (cmd) return [{ cmd, score: 100, positions: [] }];
      }
    }
    const out: Scored[] = [];
    for (const cmd of commands) {
      const onTitle = fuzzy(q, cmd.title);
      if (onTitle) {
        out.push({ cmd, score: onTitle.score + 5, positions: onTitle.positions });
        continue;
      }
      const onHay = fuzzy(q, cmd.haystack);
      if (onHay) out.push({ cmd, score: onHay.score, positions: [] });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }, [query, commands]);

  const runSelected = useCallback(
    (s: Scored | undefined) => {
      if (!s) return;
      onClose();
      void s.cmd.run();
    },
    [onClose],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        runSelected(results[sel]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [results, sel, onClose, runSelected]);

  // Keep the selected row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  let lastSection: string | null = null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
      role="dialog"
      aria-modal
      aria-label="Command palette"
    >
      <div
        className="ticked w-[min(600px,92vw)] border border-line-bright bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <span className="micro text-dim">›</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Go to screen, run an action… (try a number)"
            className="h-11 w-full bg-transparent font-mono text-[13px] text-ink placeholder:text-dim focus:outline-none"
            spellCheck={false}
          />
          <kbd className="micro shrink-0 border border-line px-1.5 py-1 text-dim">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1.5">
          {results.length === 0 && (
            <div className="px-3.5 py-6 text-center">
              <span className="micro text-dim">NO MATCHES — TRY A SCREEN NAME OR NUMBER</span>
            </div>
          )}
          {results.map((r, i) => {
            const header = r.cmd.section !== lastSection ? r.cmd.section : null;
            lastSection = r.cmd.section;
            return (
              <div key={r.cmd.id}>
                {header && (
                  <div className="micro px-3.5 pb-1 pt-2.5 text-dim">{header}</div>
                )}
                <button
                  data-idx={i}
                  onClick={() => runSelected(r)}
                  onMouseMove={() => setSel(i)}
                  className={cx(
                    "flex w-full items-center gap-3 px-3.5 py-2 text-left",
                    i === sel ? "bg-raised" : "",
                  )}
                >
                  {i === sel && <span className="absolute left-0 h-5 w-[2px] bg-accent" />}
                  {r.cmd.icon && (
                    <NavIcon
                      id={r.cmd.icon}
                      className={cx("size-4 shrink-0", i === sel ? "text-accent" : "text-dim")}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] tracking-wide text-ink">
                      <Highlighted text={r.cmd.title} positions={r.positions} />
                    </span>
                    <span className="micro mt-0.5 block truncate text-dim">{r.cmd.hint}</span>
                  </span>
                  {r.cmd.index && (
                    <span className={cx("micro shrink-0", i === sel ? "text-accent" : "text-dim")}>
                      {r.cmd.index}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2">
          <span className="micro text-dim">↑↓ NAVIGATE</span>
          <span className="micro text-dim">↵ OPEN</span>
          <span className="micro ml-auto text-dim">MERIDIAN</span>
        </div>
      </div>
    </div>
  );
}
