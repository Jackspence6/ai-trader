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

/**
 * How soon to try again after a failed poll.
 *
 * A fixed interval is wrong after an error, and the reason is not academic.
 * Every screen polls while the login page is showing, and every one of those
 * polls is refused — correctly, the site is locked. Sign in, and the next
 * attempt is a full interval away. For a 60-second endpoint like the execution
 * mode that means the badge answering "is real money at risk?" stays blank for
 * a minute after you sign in, which is the one moment you are looking at it.
 *
 * So failures back off from a short retry up to the endpoint's own cadence,
 * never beyond it. Recovery is quick, and a genuinely dead endpoint settles
 * into polling no faster than it would have anyway.
 */
const RETRY_BASE_MS = 1_500;

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
  // Consecutive failures, for the backoff. A ref rather than state: it steers
  // the next timer and nothing renders from it.
  const failures = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as T;
      if (id !== requestId.current) return;
      failures.current = 0;
      setData(json);
      setError(null);
      setLastOk(Date.now());
    } catch (e) {
      if (id !== requestId.current) return;
      failures.current += 1;
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }, [url]);

  useEffect(() => {
    // A self-scheduling timeout rather than setInterval, so the delay can
    // depend on whether the last attempt worked. setInterval cannot express
    // "sooner after a failure".
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      await load();
      if (cancelled) return;
      const n = failures.current;
      // Doubling from RETRY_BASE_MS, capped at the endpoint's own cadence so a
      // fast endpoint is never polled faster than it asked for and a dead one
      // never settles slower than it would have.
      const delay = n === 0 ? intervalMs : Math.min(intervalMs, RETRY_BASE_MS * 2 ** (n - 1));
      timer = setTimeout(() => void tick(), delay);
    };

    // Subscribing to an external system is the sanctioned use of an effect, and
    // `tick` only touches state after awaiting the network, so no cascading
    // render occurs. The disable this used to need is gone: the state writes
    // are now two awaits deep rather than one, and the rule no longer flags it.
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
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
