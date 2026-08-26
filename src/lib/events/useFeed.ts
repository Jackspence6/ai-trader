"use client";

// Opportunity feed with a two-tier source ladder:
//   1. WebSocket to the events engine (Compose, or the 24/7 box) — push, sub-second.
//   2. Polling the route handlers over Postgres, for any host without a
//      long-lived socket.
//
// Whichever tier answers first wins, and a live WS always preempts polling.
//
// There is deliberately no third tier. An earlier version fell back to
// simulated opportunities so the board was never a dead screen, which is the
// wrong trade for a desk that will place real money: a board showing plausible
// arbitrage that does not exist is worse than a board showing nothing, because
// only one of those two states makes you go and fix the scanner. When no feed
// answers, `status` is "down" and the board says so.
//
// Demo data still exists for screenshots and for showing someone the interface
// without a database behind it, but it is opt-in via NEXT_PUBLIC_DEMO=1 and the
// board watermarks itself when it is on.

import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_OPPS, walkDemo } from "./demoData";
import { WS_URL } from "./format";
import type { FeedStatus, Opportunity } from "./types";

const WS_GRACE_MS = 2500;
const POLL_MS = Number(process.env.NEXT_PUBLIC_POLL_MS ?? 6000);

/** Simulated opportunities, off unless explicitly asked for. */
const DEMO_ENABLED = process.env.NEXT_PUBLIC_DEMO === "1";

export function useOpportunityFeed() {
  const [opps, setOpps] = useState<Map<string, Opportunity>>(new Map());
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [flash, setFlash] = useState<Map<string, number>>(new Map());

  // The active tier is both a ref and a piece of state on purpose: the ref is
  // read inside timers and socket callbacks where a stale closure would pick the
  // wrong branch, and the state is what callers render. Returning the ref
  // directly would hand consumers a value that changes without a re-render.
  const tier = useRef<"none" | "demo" | "db" | "ws">("none");
  const [source, setSource] = useState<"none" | "demo" | "db" | "ws">("none");
  const setTier = useCallback((next: "none" | "demo" | "db" | "ws") => {
    tier.current = next;
    setSource(next);
  }, []);
  const wsRef = useRef<WebSocket | null>(null);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const upsert = useCallback((incoming: Opportunity[], replace = false) => {
    setOpps((prev) => {
      const next = replace ? new Map<string, Opportunity>() : new Map(prev);
      for (const o of incoming) next.set(o.id, o);
      return next;
    });
    setFlash((prev) => {
      const next = new Map(prev);
      const now = Date.now();
      for (const o of incoming) next.set(o.id, now);
      return next;
    });
  }, []);

  const stopDemo = useCallback(() => {
    if (demoTimer.current) { clearInterval(demoTimer.current); demoTimer.current = null; }
  }, []);
  const stopPoll = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
  }, []);

  const startDemo = useCallback(() => {
    if (!DEMO_ENABLED) return;
    if (tier.current === "ws" || tier.current === "db" || demoTimer.current) return;
    setTier("demo");
    setStatus("demo");
    let current = DEMO_OPPS;
    upsert(current, true);
    demoTimer.current = setInterval(() => {
      current = walkDemo(current);
      upsert(current);
    }, 2000);
  }, [upsert, setTier]);

  // ---- tier 2: poll the Neon-backed route handlers ------------------------
  const pollOnce = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/events/opportunities?state=all&limit=200", { cache: "no-store" });
      if (!res.ok) return false;
      const data = await res.json();
      if (data?.source !== "db") return false;
      if (tier.current === "ws") return true;
      if (tier.current !== "db") {
        setTier("db");
        stopDemo();
        setStatus("live");
      }
      upsert((data.opportunities ?? []) as Opportunity[], true);
      return true;
    } catch {
      return false;
    }
  }, [upsert, stopDemo, setTier]);

  useEffect(() => {
    let closed = false;
    let retry = 1000;

    // tier 1 — WebSocket
    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        return;
      }
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (tier.current !== "ws") {
            setTier("ws");
            stopDemo();
            stopPoll();
            setOpps(new Map());
          }
          setStatus("live");
          if (msg.type === "snapshot") upsert(msg.opportunities as Opportunity[], true);
          else if (msg.type === "opportunity") upsert([msg.opportunity as Opportunity]);
        } catch { /* malformed frame */ }
      };
      ws.onclose = () => {
        if (closed) return;
        if (tier.current === "ws") {
          setTier("none");
          setStatus("connecting");
        }
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    // tier 2 — start polling right away; it yields to WS if that connects.
    //
    // The state updates below all happen from a promise callback or a timer,
    // never from the effect body, so they cost no extra synchronous render.
    // The lint rule cannot follow the value through `.then()` and reads the
    // whole chain as if it ran inline.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void pollOnce().then((ok) => {
      if (ok || closed) return;
      setTimeout(() => {
        if (tier.current !== "none") return;
        if (DEMO_ENABLED) startDemo();
        // Verdict after the grace period: nothing answered, so the board says so
        // rather than sitting on "connecting" forever.
        else setStatus("down");
      }, WS_GRACE_MS);
    });
    pollTimer.current = setInterval(() => {
      if (tier.current !== "ws") void pollOnce();
    }, POLL_MS);

    return () => {
      closed = true;
      wsRef.current?.close();
      stopDemo();
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    opps: Array.from(opps.values()),
    status,
    flash,
    source,
    refresh: pollOnce,
  };
}
