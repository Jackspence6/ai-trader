"use client";

/**
 * Display-currency layer.
 *
 * The fund's books are kept in USD because that is what the venues settle in.
 * This module converts *at render time only*. Nothing downstream of here ever
 * stores a converted number.
 *
 * That rule is worth stating plainly: if we stored ZAR, every historical PnL
 * figure would silently change whenever the rand moved, and we would lose the
 * ability to tell trading performance apart from currency movement. Storing USD
 * and converting late keeps those two questions separable.
 *
 * When the FX provider is unavailable we render an explicit unavailable marker
 * rather than falling back to USD or a stale rate. A rand figure that is
 * silently a dollar figure is exactly the kind of error someone acts on.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CURRENCIES, type CurrencyCode, type FxRates } from "@/lib/market/fx";
import { cx } from "@/components/ui";

const STORAGE_KEY = "meridian.currency";

type CurrencyCtx = {
  code: CurrencyCode;
  setCode: (c: CurrencyCode) => void;
  fx: FxRates | null;
  /** Convert a USD amount; null when no rate is available. */
  convert: (usd: number) => number | null;
  symbol: string;
  loading: boolean;
};

const Ctx = createContext<CurrencyCtx | null>(null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [code, setCodeState] = useState<CurrencyCode>("USD");
  const [fx, setFx] = useState<FxRates | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the operator's choice after mount. Reading localStorage during
  // render would desync server and client HTML, so this must happen in an
  // effect — reading a browser-only store is precisely the external-system
  // synchronisation an effect is for.
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && saved in CURRENCIES) setCodeState(saved as CurrencyCode);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/fx");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as FxRates;
        if (alive) setFx(data);
      } catch {
        if (alive) setFx(null);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    // FX moves slowly; hourly is ample and keeps us well inside free-tier
    // limits on the rate provider.
    const timer = setInterval(load, 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const setCode = useCallback((c: CurrencyCode) => {
    setCodeState(c);
    window.localStorage.setItem(STORAGE_KEY, c);
  }, []);

  const convert = useCallback(
    (usd: number): number | null => {
      if (code === "USD") return usd;
      const r = fx?.rates[code];
      if (!r || !Number.isFinite(r) || r <= 0) return null;
      return usd * r;
    },
    [code, fx],
  );

  const value = useMemo(
    () => ({ code, setCode, fx, convert, symbol: CURRENCIES[code].symbol, loading }),
    [code, setCode, fx, convert, loading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrency(): CurrencyCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCurrency must be used inside CurrencyProvider");
  return c;
}

/* --------------------------------------------------------------- rendering */

function splitNum(n: number, dp: number): [string, string] {
  const s = Math.abs(n).toFixed(dp);
  const [int, frac] = s.split(".");
  return [Number(int).toLocaleString("en-US"), frac ?? ""];
}

/**
 * A USD amount rendered in the operator's chosen currency.
 *
 * The fractional part is dimmed, which materially improves scanning down a
 * column of figures — the same treatment the rest of the terminal uses.
 */
export function Money({
  usd,
  dp = 2,
  sign,
  compact,
  className,
}: {
  usd: number;
  dp?: number;
  sign?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const { convert, symbol, code, loading } = useCurrency();
  const v = convert(usd);

  if (v === null) {
    return (
      <span
        className={cx("tnum text-dim", className)}
        title={
          loading
            ? "Loading exchange rates"
            : `No ${code} rate available — refusing to show a converted figure`
        }
      >
        {loading ? "···" : "rate n/a"}
      </span>
    );
  }

  const s = sign ? (v >= 0 ? "+" : "−") : v < 0 ? "−" : "";

  if (compact) {
    const abs = Math.abs(v);
    const short =
      abs >= 1_000_000
        ? (abs / 1_000_000).toFixed(2) + "M"
        : abs >= 1_000
          ? (abs / 1_000).toFixed(1) + "k"
          : abs.toFixed(dp);
    return (
      <span className={cx("tnum", className)}>
        {s}
        {symbol}
        {short}
      </span>
    );
  }

  const [int, frac] = splitNum(v, dp);
  return (
    <span className={cx("tnum", className)}>
      {s}
      {symbol}
      {int}
      {frac && <span className="opacity-45">.{frac}</span>}
    </span>
  );
}

/** Currency selector for the top bar. */
export function CurrencySwitch() {
  const { code, setCode, fx } = useCurrency();
  const codes = Object.keys(CURRENCIES) as CurrencyCode[];

  return (
    <div
      className="flex items-center"
      title={
        fx && !fx.degraded
          ? `1 USD = ${fx.rates.ZAR.toFixed(2)} ZAR · ${fx.rates.EUR.toFixed(3)} EUR · ${fx.rates.GBP.toFixed(3)} GBP`
          : "Exchange rates unavailable"
      }
    >
      {codes.map((c) => (
        <button
          key={c}
          onClick={() => setCode(c)}
          aria-pressed={code === c}
          className={cx(
            "micro border px-1.5 py-1 transition-colors -ml-px first:ml-0",
            code === c
              ? "border-accent/50 bg-accent/10 text-accent z-10"
              : "border-line-bright text-dim hover:text-muted",
          )}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
