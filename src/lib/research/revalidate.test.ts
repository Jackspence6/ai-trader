import { describe, expect, it } from "vitest";
import {
  buildAlerts,
  classifyHealth,
  openPositionsByStrategy,
  type VerdictRow,
} from "./revalidate";

const stats = (annualised: number, sharpe: number | null = 1.5, trades = 20) => ({
  annualisedReturnPct: annualised,
  sharpe,
  trades,
});

const row = (over: Partial<VerdictRow>): VerdictRow => ({
  code: "L1",
  name: "Crypto funding carry",
  sleeveId: "core",
  funded: true,
  dedicated: true,
  openPositions: 0,
  periodDays: 180,
  totalReturnPct: 0.02,
  annualisedReturnPct: 0.04,
  sharpe: 1.2,
  maxDrawdownPct: 0.01,
  trades: 20,
  winRate: 0.6,
  health: "healthy",
  reasons: [],
  deltaAnnualisedPct: null,
  ...over,
});

describe("classifyHealth", () => {
  it("a strategy that loses after costs is failing, whatever else is true", () => {
    const v = classifyHealth(stats(-0.02, 2.0, 100), 0.05);
    expect(v.health).toBe("failing");
    expect(v.reasons).toHaveLength(1);
  });

  it("earning with a solid Sharpe and history is healthy", () => {
    const v = classifyHealth(stats(0.05, 1.1, 30), null);
    expect(v.health).toBe("healthy");
    expect(v.reasons).toHaveLength(0);
  });

  it("thin evidence is watch, not healthy — fewer than 5 trades", () => {
    const v = classifyHealth(stats(0.05, 1.1, 3), null);
    expect(v.health).toBe("watch");
    expect(v.reasons[0]).toMatch(/fewer than 5 trades/);
  });

  it("weak risk-adjusted return is watch", () => {
    expect(classifyHealth(stats(0.02, 0.1), null).health).toBe("watch");
  });

  it("null Sharpe (no variance in returns) does not trigger the weakness rule", () => {
    expect(classifyHealth(stats(0.05, null), null).health).toBe("healthy");
  });

  it("earning less than half of the previous check is deterioration", () => {
    const v = classifyHealth(stats(0.02), 0.06);
    expect(v.health).toBe("watch");
    expect(v.reasons[0]).toMatch(/less than half/);
  });

  it("a negligible previous reading cannot flag deterioration", () => {
    // 0.4% → 0.1% is noise around zero, not a halving worth an alert.
    expect(classifyHealth(stats(0.001), 0.004).health).toBe("healthy");
  });

  it("first run has no previous to deteriorate against", () => {
    expect(classifyHealth(stats(0.04), null).health).toBe("healthy");
  });

  it("multiple weaknesses accumulate as reasons", () => {
    const v = classifyHealth(stats(0.02, 0.1, 2), 0.06);
    expect(v.health).toBe("watch");
    expect(v.reasons).toHaveLength(3);
  });
});

describe("buildAlerts", () => {
  it("failing with a dedicated funded sleeve is the loud one", () => {
    const alerts = buildAlerts([row({ code: "F2", health: "failing", funded: true })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/F2/);
    expect(alerts[0]).toMatch(/holds live capital/);
  });

  it("failing with open positions alerts even in a shared sleeve", () => {
    const alerts = buildAlerts([
      row({ code: "L2", health: "failing", dedicated: false, openPositions: 2 }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/open position/);
  });

  it("failing but idle in a SHARED sleeve is the designed state — no alarm", () => {
    // L2 in core: scored, visible, blocked by the entry gate. The health row
    // says FAILING; ringing the alarm for it every run would train the
    // operator to ignore alarms.
    expect(
      buildAlerts([row({ code: "L2", health: "failing", dedicated: false })]),
    ).toHaveLength(0);
  });

  it("unfunded + healthy + meaningful return proposes a promotion review", () => {
    const alerts = buildAlerts([
      row({ code: "L2", funded: false, health: "healthy", annualisedReturnPct: 0.05 }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/promotion review/);
  });

  it("unfunded + healthy but marginal return stays quiet", () => {
    expect(
      buildAlerts([
        row({ funded: false, health: "healthy", annualisedReturnPct: 0.01 }),
      ]),
    ).toHaveLength(0);
  });

  it("funded + healthy raises nothing — that is the desired state", () => {
    expect(buildAlerts([row({})])).toHaveLength(0);
  });

  it("unfunded + failing raises nothing — the pipeline already worked", () => {
    expect(buildAlerts([row({ funded: false, health: "failing" })])).toHaveLength(0);
  });
});

describe("openPositionsByStrategy", () => {
  const fill = (
    strategy: string,
    side: string,
    qty: number,
    market = "spot",
    venue = "Binance",
    asset = "BNB",
  ) => ({ strategy, venue, asset, market, side, qty });

  it("a delta-neutral pair is two open positions of one strategy", () => {
    const open = openPositionsByStrategy([
      fill("L1", "buy", 0.5, "spot"),
      fill("L1", "sell", 0.5, "perp"),
    ]);
    expect(open.get("L1")).toBe(2);
  });

  it("a closed round trip nets to zero and disappears", () => {
    const open = openPositionsByStrategy([
      fill("H1", "buy", 1.0),
      fill("H1", "sell", 1.0),
    ]);
    expect(open.get("H1")).toBeUndefined();
  });

  it("strategies are counted independently", () => {
    const open = openPositionsByStrategy([
      fill("L1", "buy", 0.5),
      fill("F1", "buy", 0.8, "spot", "fx", "USDJPY"),
    ]);
    expect(open.get("L1")).toBe(1);
    expect(open.get("F1")).toBe(1);
  });
});
