"use client";

/**
 * The lock screen.
 *
 * Visually this is a vault dial crossed with a radar: concentric tick rings
 * counter-rotating behind a scanning wedge, with the Meridian mark at the
 * centre. It uses the same tokens as the rest of the terminal — same greys,
 * same accent, same monospace micro-labels — so it reads as the front door of
 * this system rather than a generic login pasted on top.
 *
 * The states carry meaning rather than decoration:
 *   idle       slow counter-rotation, breathing core
 *   verifying  rings accelerate, sweep speeds up
 *   granted    rings snap to a stop, accent pulse expands, screen releases
 *   denied     short sharp shake, everything goes red, rings keep turning
 *
 * The password never reaches the client. This form posts it and the server
 * decides; a client-side comparison would ship the secret to every visitor.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cx } from "@/components/ui";

type State = "idle" | "verifying" | "granted" | "denied";

export default function LoginPage() {
  return (
    // `useSearchParams` reads request-time data, so it needs a real Suspense
    // boundary. Without one the whole page defers to request time and the
    // visitor gets a blank frame before anything paints.
    <Suspense fallback={<LockFallback />}>
      <LockScreen />
    </Suspense>
  );
}

/** Static shell for the prerendered shell — same geometry, no motion. */
function LockFallback() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[380px]">
        <div className="mx-auto size-[190px]" />
        <p className="micro mt-9 text-center text-dim">MUSKET GOOSE</p>
      </div>
    </main>
  );
}

function LockScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d: { configured: boolean }) => {
        if (alive) setConfigured(d.configured);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (state === "verifying" || state === "granted") return;

      setState("verifying");
      setMessage(null);

      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });

        if (res.ok) {
          setState("granted");
          // Let the unlock animation land before navigating. Short enough not
          // to feel like latency, long enough to read as a response.
          setTimeout(() => router.replace(next), 900);
          return;
        }

        const d = (await res.json()) as { error?: string };
        setState("denied");
        setMessage(d.error ?? "Incorrect password");
        setPassword("");
        inputRef.current?.focus();
        setTimeout(() => setState("idle"), 700);
      } catch {
        setState("denied");
        setMessage("Could not reach the server");
        setTimeout(() => setState("idle"), 700);
      }
    },
    [password, state, router, next],
  );

  const denied = state === "denied";
  const granted = state === "granted";
  const busy = state === "verifying";

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-4">
      <Backdrop state={state} />

      <div
        className={cx(
          "relative z-10 w-full max-w-[380px]",
          denied && "[animation:lock-shake_0.5s_ease-in-out]",
        )}
      >
        <Dial state={state} />

        <div
          className="mt-9 text-center"
          style={{ animation: "fade-rise 0.5s ease-out both", animationDelay: "0.1s" }}
        >
          <h1 className="text-[15px] font-medium tracking-[0.22em] text-ink">
            MUSKET GOOSE
          </h1>
          <p className="micro mt-2 text-dim">
            {granted ? "ACCESS GRANTED" : busy ? "VERIFYING" : "AUTONOMOUS TRADING · RESTRICTED"}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="mt-7"
          style={{ animation: "fade-rise 0.5s ease-out both", animationDelay: "0.2s" }}
        >
          <div
            className={cx(
              "flex items-center border bg-panel/60 backdrop-blur-[1px] transition-colors duration-200",
              denied
                ? "border-down"
                : granted
                  ? "border-up"
                  : "border-line-bright focus-within:border-accent/60",
            )}
          >
            <span className="micro select-none px-3 text-dim">PASS</span>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || granted}
              autoComplete="current-password"
              spellCheck={false}
              aria-label="Password"
              className="tnum w-full bg-transparent py-3 pr-3 text-[14px] tracking-[0.3em] text-ink outline-none placeholder:tracking-normal placeholder:text-dim disabled:opacity-60"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={busy || granted || !password}
            className={cx(
              "micro mt-2.5 w-full border py-3 transition-colors duration-200 disabled:opacity-40",
              granted
                ? "border-up bg-up/15 text-up"
                : "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20",
            )}
          >
            {granted ? "UNLOCKED" : busy ? "VERIFYING…" : "UNLOCK"}
          </button>

          <div className="mt-3 min-h-[32px] text-center">
            {message && (
              <p className="text-[11.5px] leading-relaxed text-down">{message}</p>
            )}
            {configured === false && !message && (
              <p className="text-[11.5px] leading-relaxed text-warn">
                SITE_PASSWORD is not set on this deployment. The site stays locked
                until it is.
              </p>
            )}
          </div>
        </form>

        <p
          className="mt-2 text-center text-[10.5px] leading-relaxed text-dim"
          style={{ animation: "fade-rise 0.5s ease-out both", animationDelay: "0.35s" }}
        >
          A shared password, not an account. It keeps this off the open internet
          — it does not identify who is signing in.
        </p>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------- backdrop */

function Backdrop({ state }: { state: State }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      {/* Radial vignette, so the dial sits in a pool of light. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 50% 42%, rgba(139,147,255,0.09), transparent 60%)",
        }}
      />

      {/* Drifting scanline — slow enough to notice only once. */}
      <div
        className="lock-scanline absolute inset-x-0 h-[36vh] opacity-[0.5]"
        style={{
          background:
            "linear-gradient(to bottom, transparent, rgba(139,147,255,0.055), transparent)",
          animation: "scanline-drift 9s linear infinite",
        }}
      />

      {/* Denial wash. */}
      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          background:
            "radial-gradient(circle at 50% 42%, rgba(255,97,82,0.13), transparent 62%)",
          opacity: state === "denied" ? 1 : 0,
        }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- dial */

function Dial({ state }: { state: State }) {
  const denied = state === "denied";
  const granted = state === "granted";
  const busy = state === "verifying";

  // Rings accelerate while verifying and stop dead on success — the motion
  // itself reports the state, so it reads before the label does.
  const speed = (base: number) => (granted ? "0s" : busy ? `${base / 5}s` : `${base}s`);
  const stroke = denied ? "var(--color-down)" : granted ? "var(--color-up)" : "var(--color-accent)";

  return (
    <div className="relative mx-auto size-[190px]">
      {/* Outer tick ring */}
      <svg
        viewBox="0 0 200 200"
        className="lock-ring absolute inset-0 size-full"
        style={{
          animation: `ring-spin ${speed(46)} linear infinite`,
          animationPlayState: granted ? "paused" : "running",
        }}
      >
        {Array.from({ length: 60 }, (_, i) => {
          const major = i % 5 === 0;
          return (
            <line
              key={i}
              x1="100"
              y1={major ? 6 : 9}
              x2="100"
              y2={major ? 17 : 14}
              stroke={stroke}
              strokeWidth={major ? 1.6 : 0.8}
              opacity={major ? 0.72 : 0.3}
              transform={`rotate(${i * 6} 100 100)`}
              style={{ transition: "stroke 0.3s" }}
            />
          );
        })}
      </svg>

      {/* Mid ring, counter-rotating */}
      <svg
        viewBox="0 0 200 200"
        className="lock-ring absolute inset-0 size-full"
        style={{
          animation: `ring-spin-rev ${speed(30)} linear infinite`,
          animationPlayState: granted ? "paused" : "running",
        }}
      >
        <circle
          cx="100"
          cy="100"
          r="66"
          fill="none"
          stroke={stroke}
          strokeWidth="1"
          opacity="0.28"
          strokeDasharray="3 9"
          style={{ transition: "stroke 0.3s" }}
        />
        {[0, 90, 180, 270].map((deg) => (
          <line
            key={deg}
            x1="100"
            y1="28"
            x2="100"
            y2="40"
            stroke={stroke}
            strokeWidth="1.4"
            opacity="0.6"
            transform={`rotate(${deg} 100 100)`}
            style={{ transition: "stroke 0.3s" }}
          />
        ))}
      </svg>

      {/* Radar sweep */}
      <div
        className="lock-sweep absolute inset-0"
        style={{
          animation: `sweep-rotate ${speed(6)} linear infinite`,
          animationPlayState: granted ? "paused" : "running",
          opacity: granted ? 0 : 1,
          transition: "opacity 0.4s",
        }}
      >
        <div
          className="absolute inset-[18%] rounded-full"
          style={{
            background: `conic-gradient(from 0deg, ${
              denied ? "rgba(255,97,82,0.3)" : "rgba(139,147,255,0.26)"
            }, transparent 22%)`,
          }}
        />
      </div>

      {/* Inner ring */}
      <svg viewBox="0 0 200 200" className="absolute inset-0 size-full">
        <circle
          cx="100"
          cy="100"
          r="44"
          fill="none"
          stroke={stroke}
          strokeWidth="1"
          opacity="0.42"
          style={{ transition: "stroke 0.3s" }}
        />
      </svg>

      {/* Unlock pulse */}
      {granted && (
        <div
          className="absolute inset-[22%] rounded-full border-2"
          style={{
            borderColor: "var(--color-up)",
            animation: "lock-unlock-pulse 0.9s ease-out both",
          }}
        />
      )}

      {/* Core mark — the same glyph as the nav rail */}
      <div className="absolute inset-0 grid place-items-center">
        <div
          className="lock-core relative size-9"
          style={{
            animation: granted ? undefined : "lock-breathe 3.4s ease-in-out infinite",
          }}
        >
          <div
            className="absolute inset-0 border transition-colors duration-300"
            style={{ borderColor: stroke }}
          />
          <div
            className="absolute inset-[7px] transition-colors duration-300"
            style={{ background: stroke }}
          />
        </div>
      </div>
    </div>
  );
}
