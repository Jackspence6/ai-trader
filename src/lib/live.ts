"use client";

/**
 * Polling hook for live endpoints.
 *
 * DESIGN.md §8 requires that every number which could be stale shows its age,
 * and that connection state is visible. So this hook returns not just data but
 * `ageSeconds` and a connection state, and every consumer is expected to
 * surface them.
 *
 * Polling rather than WebSocket is the honest phase-1 choice: the real-time
 * push path belongs to the engine's md-gateway, which does not exist yet.
 * Presenting a polled feed as a live socket would misrepresent how fresh the
 * data actually is.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type LiveState<T> = {
  data: T | null;
  error: string | null;
  /** Seconds since the last successful load. */
  ageSeconds: number;
  status: "connecting" | "live" | "stale" | "error";
  refresh: () => void;
};

export function useLive<T>(
  url: string,
  intervalMs = 15_000,
  staleAfterSeconds = 60,
): LiveState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);

  // `now` is held in state and advanced by a timer rather than read during
  // render. Calling Date.now() in the render body would make the component
  // impure — its output would change on any incidental re-render.
  const [now, setNow] = useState(0);

  // Guards against a slow response from a previous URL landing after a newer
  // one, which would show the wrong asset's data under the right heading.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as T;
      if (id !== requestId.current) return;
      setData(json);
      setError(null);
      setLastOk(Date.now());
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [url]);

  useEffect(() => {
    // Subscribing to an external system and calling setState from the callback
    // is exactly the sanctioned use of an effect. `load` is async and only
    // touches state after awaiting the network, so no cascading render occurs —
    // the lint rule cannot see through the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs]);

  // Separate 1s ticker so the displayed age counts up smoothly between polls
  // rather than jumping only when new data lands.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const ageSeconds =
    lastOk === null || now === 0 ? 0 : Math.max(0, Math.floor((now - lastOk) / 1000));

  const status: LiveState<T>["status"] =
    lastOk === null
      ? error
        ? "error"
        : "connecting"
      : ageSeconds > staleAfterSeconds
        ? "stale"
        : error
          ? "error"
          : "live";

  return { data, error, ageSeconds, status, refresh: load };
}
