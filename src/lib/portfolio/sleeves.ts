/**
 * Sleeves — separately-mandated books inside one account.
 *
 * One venue account, one pool of capital, but internally divided into sleeves
 * that behave like independent sub-accounts: each has its own capital
 * allocation, its own permitted strategies, its own risk limits, and its own
 * PnL attribution.
 *
 * The property that makes this worth building rather than just "allocating
 * differently" is **blast-radius isolation**. A sleeve that breaches its own
 * drawdown limit halts *that sleeve only*. The market-neutral book keeps
 * earning while the directional book sits in timeout. Without sleeves, one bad
 * strategy either takes the whole account down or has to be sized so small it
 * cannot matter — there is no middle setting.
 *
 * The honest framing on risk, which the UI repeats because it is easy to
 * forget: **higher risk does not reliably mean higher return.** It means wider
 * outcomes in both directions. A sleeve with a 35% expected drawdown is not a
 * sleeve that earns more — it is one that *might*, and might equally hand back
 * a third of its capital. The only thing that scales reliably with risk is the
 * size of the range.
 */

export type RiskBand = "low" | "medium" | "high" | "very-high";

/**
 * Asset class.
 *
 * A first-class dimension rather than a label, because the two classes differ
 * in ways that matter to every calculation downstream: forex is roughly 5x less
 * volatile than crypto (EUR/USD ~7% annualised against BTC ~34%), trades on
 * business days only, and is priced in pips rather than percent.
 *
 * The reason to hold both is **correlation, not return**. Measured over 269
 * overlapping sessions, EUR/USD against BTC is -0.07 and ZAR/USD against BTC is
 * -0.20 — effectively uncorrelated. Two uncorrelated books of the same size
 * have lower combined volatility than either alone, which is a real and rare
 * free lunch. It is not a way to make more money per unit of capital.
 */
export type AssetClass = "crypto" | "forex";

export const ASSET_CLASSES: {
  id: AssetClass;
  label: string;
  note: string;
  /** Typical annualised volatility of the underlying, measured not assumed. */
  typicalVol: string;
}[] = [
  {
    id: "crypto",
    label: "Crypto",
    note: "Trades continuously. High volatility, deep perp markets, funding rates to harvest.",
    typicalVol: "34–52%",
  },
  {
    id: "forex",
    label: "Forex",
    note: "Business days only. Low volatility and near-uncorrelated with crypto — held to steady the book, not to juice it.",
    typicalVol: "7–16%",
  },
];

export type SleeveDef = {
  id: string;
  name: string;
  assetClass: AssetClass;
  band: RiskBand;
  /** One-line mandate — what this sleeve is *for*. */
  mandate: string;
  /** Strategy codes this sleeve may run, subject to the fund tier also allowing them. */
  strategies: string[];

  /** Realistic annualised return range. Wide on purpose for the risky sleeves. */
  targetAprLow: number;
  targetAprHigh: number;
  /** Drawdown to *expect*, not a limit — the limits are set separately below. */
  expectedMaxDrawdown: number;

  /** Default risk limits for this sleeve, all as fractions of sleeve capital. */
  limits: {
    /** Loss in one day that halts this sleeve. */
    dailyLossPct: number;
    /** Decline from this sleeve's own high-water mark that halts it. */
    maxDrawdownPct: number;
    /** Largest single position, as a share of sleeve capital. */
    maxPositionPct: number;
    /** Leverage ceiling within this sleeve. */
    maxLeverage: number;
    maxConcurrentPositions: number;
  };

  /** The thing most likely to go wrong here. Shown in the UI, not buried. */
  primaryRisk: string;
  /** What this sleeve does NOT do — the expectation-setting line. */
  doesNotDo: string;
};

/**
 * The four sleeves.
 *
 * Ordered from most to least defensive. The set is deliberately small: more
 * sleeves means each gets less capital, and below the exchange minimums a
 * sleeve stops being able to trade at all (see `minimumViableCapital`).
 */
export const SLEEVES: SleeveDef[] = [
  {
    id: "core",
    assetClass: "crypto",
    name: "Core",
    band: "low",
    mandate:
      "Market-neutral carry. Gets paid for warehousing risk that leveraged traders do not want, without taking a directional view.",
    strategies: ["L1", "L2", "L3"],
    targetAprLow: 0.08,
    targetAprHigh: 0.2,
    expectedMaxDrawdown: 0.06,
    limits: {
      dailyLossPct: 0.02,
      maxDrawdownPct: 0.08,
      maxPositionPct: 0.35,
      maxLeverage: 3,
      maxConcurrentPositions: 6,
    },
    primaryRisk:
      "Funding inverts and we start paying, or the perp leg liquidates on a sharp move because margin was not topped up — delta-neutrality protects PnL, not margin.",
    doesNotDo:
      "Does not profit from a bull market. Neutral means neutral to the upside too.",
  },
  {
    id: "accumulation",
    assetClass: "crypto",
    name: "Accumulation",
    band: "medium",
    mandate:
      "Hold spot BTC and ETH, with a funding overlay when carry is rich. This is the sleeve that captures a bull market — and the one that falls with it.",
    strategies: ["B1", "B2"],
    targetAprLow: -0.6,
    targetAprHigh: 1.0,
    expectedMaxDrawdown: 0.75,
    limits: {
      dailyLossPct: 0.1,
      maxDrawdownPct: 0.85,
      maxPositionPct: 0.6,
      maxLeverage: 1,
      maxConcurrentPositions: 3,
    },
    primaryRisk:
      "Ordinary crypto drawdowns. BTC has fallen more than 70% from a high three separate times, and nothing about this sleeve prevents that — it is the exposure, not a hedge against it.",
    doesNotDo:
      "Does not use leverage and does not stop out. It is a holding sleeve; if you would not sit through a 70% drawdown, this is not where the money goes.",
  },
  {
    id: "systematic",
    assetClass: "crypto",
    name: "Systematic",
    band: "high",
    mandate:
      "Rules-based trend following on majors, volatility-sized with ATR stops. Aims to profit from large directional moves in either direction.",
    strategies: ["H1", "H2", "M2"],
    targetAprLow: -0.2,
    targetAprHigh: 0.4,
    expectedMaxDrawdown: 0.35,
    limits: {
      dailyLossPct: 0.04,
      maxDrawdownPct: 0.25,
      maxPositionPct: 0.25,
      maxLeverage: 2,
      maxConcurrentPositions: 4,
    },
    primaryRisk:
      "Long losing streaks. Trend systems typically win under 40% of trades and pay for that with a few large winners — so a year of small losses before a payoff is normal behaviour, not a malfunction. The temptation to switch it off mid-drawdown is the real risk.",
    doesNotDo:
      "Does not predict. It reacts to moves already underway and gives back part of every trend at the exit.",
  },
  {
    id: "opportunistic",
    assetClass: "crypto",
    name: "Opportunistic",
    band: "very-high",
    mandate:
      "Short-horizon dislocations — funding at historical extremes, liquidation-cascade fades, basis convergence. Smallest allocation, tightest invalidation.",
    strategies: ["H3", "H4"],
    targetAprLow: -0.4,
    targetAprHigh: 0.6,
    expectedMaxDrawdown: 0.45,
    limits: {
      dailyLossPct: 0.05,
      maxDrawdownPct: 0.3,
      maxPositionPct: 0.15,
      maxLeverage: 3,
      maxConcurrentPositions: 3,
    },
    primaryRisk:
      "These trades fade a move that is already violent, so being early is indistinguishable from being wrong until it resolves. Invalidation must be mechanical.",
    doesNotDo:
      "Does not scale. The edges are real but small and capacity-limited; this sleeve does not become the main engine no matter how well it performs.",
  },
  {
    id: "fx-carry",
    assetClass: "forex",
    name: "FX Carry",
    band: "low",
    mandate:
      "Hold high-yield currencies against low-yield ones and collect the interest differential. The original carry trade, and the same shape as the crypto funding carry this system already runs.",
    strategies: ["F1"],
    targetAprLow: -0.05,
    targetAprHigh: 0.08,
    expectedMaxDrawdown: 0.12,
    limits: {
      dailyLossPct: 0.02,
      maxDrawdownPct: 0.1,
      maxPositionPct: 0.3,
      // Deliberately low. Leverage is the only thing that makes forex feel
      // exciting, and it adds no expected return — it scales both directions
      // and adds financing cost. 2x is enough to make a 7%-vol asset
      // meaningful without turning it into the thing 68-85% of retail CFD
      // accounts lose money on.
      maxLeverage: 2,
      maxConcurrentPositions: 4,
    },
    primaryRisk:
      "Carry unwinds are violent and correlated. High-yield currencies fall fastest exactly when everything else does — the yen carry unwind of August 2024 erased years of accumulated differential in days. Picking up nickels in front of a steamroller is the standard description and it is accurate.",
    doesNotDo:
      "Does not work at most retail brokers. Swap markups are frequently large enough to make BOTH directions negative, so you pay to hold either side — the differential has to survive that before anything is left.",
  },
  {
    id: "fx-trend",
    assetClass: "forex",
    name: "FX Trend",
    band: "medium",
    mandate:
      "Rules-based trend following on major pairs, volatility-sized with ATR stops. Currencies trend on macro cycles that have nothing to do with crypto, which is the entire reason this sleeve exists.",
    strategies: ["F2"],
    targetAprLow: -0.15,
    targetAprHigh: 0.25,
    expectedMaxDrawdown: 0.2,
    limits: {
      dailyLossPct: 0.03,
      maxDrawdownPct: 0.18,
      maxPositionPct: 0.25,
      maxLeverage: 3,
      maxConcurrentPositions: 4,
    },
    primaryRisk:
      "Long stretches of chop. Majors range for months at a time, and a trend system in a range bleeds small losses continuously while waiting for a move that may not come.",
    doesNotDo:
      "Does not produce large numbers. A 7%-volatility asset cannot generate crypto-sized returns without leverage that would defeat the point of holding it — this sleeve is here to be uncorrelated, not to be big.",
  },
];

export const SLEEVE_IDS = SLEEVES.map((s) => s.id);

/** Sleeves in one asset class. */
export function sleevesIn(assetClass: AssetClass): SleeveDef[] {
  return SLEEVES.filter((s) => s.assetClass === assetClass);
}

export function sleeveById(id: string): SleeveDef | undefined {
  return SLEEVES.find((s) => s.id === id);
}

/**
 * Which sleeve a strategy code belongs to.
 *
 * The mapping is strictly one-to-one, and it must stay that way: routing is
 * what decides which pool of capital funds a trade and whose limits apply. A
 * code listed under two sleeves would silently always resolve to the first,
 * so the second sleeve would never receive the capital its operator assigned.
 * There is a test asserting uniqueness.
 */
export function sleeveForStrategy(code: string): SleeveDef | undefined {
  return SLEEVES.find((s) => s.strategies.includes(code));
}

/* -------------------------------------------------------------- allocation */

export type SleeveAllocation = {
  sleeveId: string;
  /** Capital assigned to this sleeve, in USD. */
  allocatedUsd: number;
  /** Operator switch — off means the sleeve does not trade at all. */
  enabled: boolean;
  /** Set by a risk breach. Distinct from `enabled` so we can tell them apart. */
  halted: boolean;
};

export function defaultAllocations(): SleeveAllocation[] {
  return SLEEVES.map((s) => ({
    sleeveId: s.id,
    allocatedUsd: 0,
    // Only Core is on by default. Every other sleeve is an explicit decision to
    // accept a specific kind of loss, and defaults should not make that choice
    // on the operator's behalf.
    enabled: s.id === "core",
    halted: false,
  }));
}

export type SleeveState = {
  def: SleeveDef;
  allocation: SleeveAllocation;
  allocatedUsd: number;
  /** Share of fund NAV, 0–1. */
  shareOfNav: number;
  /** Capital currently in positions. Zero until the engine reports fills. */
  deployedUsd: number;
  availableUsd: number;
  /** Realised + unrealised PnL for this sleeve. */
  pnlUsd: number;
  /** Whether this sleeve may trade right now, and why not if not. */
  tradable: boolean;
  blockedReason: string | null;
  /** Absolute loss that would trip this sleeve's own limits. */
  dailyLossLimitUsd: number;
  drawdownLimitUsd: number;
  maxPositionUsd: number;
  /** Capital below which this sleeve cannot clear exchange minimums usefully. */
  minimumViableUsd: number;
};

export type PortfolioState = {
  navUsd: number;
  totalAllocatedUsd: number;
  /** NAV not assigned to any sleeve. Not idle — it is the buffer. */
  reserveUsd: number;
  reserveShare: number;
  sleeves: SleeveState[];
  /** True when allocations exceed NAV, which must block saving. */
  overAllocated: boolean;
  /** Blended expected return range across enabled, funded sleeves. */
  blendedAprLow: number;
  blendedAprHigh: number;
  /** Capital-weighted expected drawdown. */
  blendedExpectedDrawdown: number;
};

/**
 * Minimum capital at which a sleeve can trade without being destroyed by
 * fixed costs.
 *
 * Derived rather than guessed: a sleeve needs to place a position at the venue
 * minimum (~$10) without that single position breaching its own
 * `maxPositionPct`. So the floor is `minNotional / maxPositionPct`. A sleeve
 * capped at 15% per position needs ~$67 before it can place one legal trade.
 *
 * This is the sleeve-level version of the argument in DESIGN.md §7: splitting
 * a small account into many sleeves does not diversify it, it just pushes every
 * sleeve below the size where fees and minimums stop mattering.
 */
export function minimumViableCapital(def: SleeveDef, venueMinNotionalUsd = 10): number {
  if (def.limits.maxPositionPct <= 0) return Infinity;
  return venueMinNotionalUsd / def.limits.maxPositionPct;
}

/**
 * Compute full portfolio state from NAV and allocations.
 *
 * `deployed` and `pnl` are passed in rather than assumed — they come from the
 * engine's position ledger, which does not exist yet, so today they are zero
 * and the UI says so.
 */
export function computePortfolio(
  navUsd: number,
  allocations: SleeveAllocation[],
  deployed: Record<string, number> = {},
  pnl: Record<string, number> = {},
): PortfolioState {
  const byId = new Map(allocations.map((a) => [a.sleeveId, a]));

  const sleeves: SleeveState[] = SLEEVES.map((def) => {
    const allocation = byId.get(def.id) ?? {
      sleeveId: def.id,
      allocatedUsd: 0,
      enabled: false,
      halted: false,
    };

    const allocatedUsd = Math.max(allocation.allocatedUsd, 0);
    const deployedUsd = deployed[def.id] ?? 0;
    const minimumViableUsd = minimumViableCapital(def);

    let tradable = true;
    let blockedReason: string | null = null;

    if (!allocation.enabled) {
      tradable = false;
      blockedReason = "Sleeve disabled";
    } else if (allocation.halted) {
      tradable = false;
      blockedReason = "Halted by a risk breach";
    } else if (allocatedUsd <= 0) {
      tradable = false;
      blockedReason = "No capital allocated";
    } else if (allocatedUsd < minimumViableUsd) {
      tradable = false;
      blockedReason = `Below minimum viable capital of $${minimumViableUsd.toFixed(0)} — cannot place a position at the venue minimum without breaching its own position cap`;
    }

    return {
      def,
      allocation,
      allocatedUsd,
      shareOfNav: navUsd > 0 ? allocatedUsd / navUsd : 0,
      deployedUsd,
      availableUsd: Math.max(allocatedUsd - deployedUsd, 0),
      pnlUsd: pnl[def.id] ?? 0,
      tradable,
      blockedReason,
      dailyLossLimitUsd: allocatedUsd * def.limits.dailyLossPct,
      drawdownLimitUsd: allocatedUsd * def.limits.maxDrawdownPct,
      maxPositionUsd: allocatedUsd * def.limits.maxPositionPct,
      minimumViableUsd,
    };
  });

  const totalAllocatedUsd = sleeves.reduce((a, s) => a + s.allocatedUsd, 0);
  const reserveUsd = navUsd - totalAllocatedUsd;

  // Blend only over sleeves that are actually enabled and funded — including a
  // disabled sleeve would advertise a return profile the portfolio cannot
  // produce.
  const active = sleeves.filter((s) => s.allocation.enabled && s.allocatedUsd > 0);
  const activeCapital = active.reduce((a, s) => a + s.allocatedUsd, 0);

  const weighted = (pick: (s: SleeveState) => number) =>
    activeCapital > 0
      ? active.reduce((a, s) => a + pick(s) * s.allocatedUsd, 0) / activeCapital
      : 0;

  // Blended figures are stated against total NAV, not just deployed capital.
  // Reserve earns nothing, and hiding that would overstate the portfolio.
  const deployedShare = navUsd > 0 ? activeCapital / navUsd : 0;

  return {
    navUsd,
    totalAllocatedUsd,
    reserveUsd,
    reserveShare: navUsd > 0 ? reserveUsd / navUsd : 0,
    sleeves,
    overAllocated: totalAllocatedUsd > navUsd + 1e-9,
    blendedAprLow: weighted((s) => s.def.targetAprLow) * deployedShare,
    blendedAprHigh: weighted((s) => s.def.targetAprHigh) * deployedShare,
    blendedExpectedDrawdown: weighted((s) => s.def.expectedMaxDrawdown) * deployedShare,
  };
}

/**
 * Clamp allocations so they are individually sane and collectively fit inside
 * NAV.
 *
 * When the total exceeds NAV we scale every sleeve down proportionally rather
 * than rejecting the save. Refusing to save leaves the operator stuck with an
 * old configuration during exactly the moment they are trying to reduce risk;
 * scaling preserves their intended *ratios* and reports what it did.
 */
export function reconcileAllocations(
  navUsd: number,
  allocations: SleeveAllocation[],
): { allocations: SleeveAllocation[]; adjustments: string[] } {
  const adjustments: string[] = [];

  const cleaned: SleeveAllocation[] = SLEEVES.map((def) => {
    const a = allocations.find((x) => x.sleeveId === def.id);
    const raw = Number(a?.allocatedUsd ?? 0);
    const allocatedUsd = Number.isFinite(raw) && raw > 0 ? raw : 0;
    return {
      sleeveId: def.id,
      allocatedUsd,
      enabled: Boolean(a?.enabled),
      halted: Boolean(a?.halted),
    };
  });

  const total = cleaned.reduce((s, a) => s + a.allocatedUsd, 0);

  if (navUsd <= 0) {
    // No capital: allocations are aspirational only. Keep the operator's
    // numbers rather than zeroing their planning.
    return { allocations: cleaned, adjustments };
  }

  if (total > navUsd) {
    const scale = navUsd / total;
    adjustments.push(
      `Allocations totalled $${total.toFixed(2)} against NAV $${navUsd.toFixed(2)}; scaled down by ${((1 - scale) * 100).toFixed(1)}%`,
    );
    for (const a of cleaned) a.allocatedUsd = a.allocatedUsd * scale;
  }

  return { allocations: cleaned, adjustments };
}

/** Apply a preset risk posture, returning USD allocations against NAV. */
export const PRESETS: Record<
  string,
  { label: string; description: string; weights: Record<string, number> }
> = {
  defensive: {
    label: "Defensive",
    description:
      "Market-neutral only, with a large cash reserve. Lowest variance; gives up the upside entirely.",
    weights: { core: 0.6, accumulation: 0, systematic: 0, opportunistic: 0 },
  },
  balanced: {
    label: "Balanced",
    description:
      "Carry as the base with a meaningful spot holding. Participates in a bull market while the neutral book carries the quiet periods.",
    weights: { core: 0.5, accumulation: 0.3, systematic: 0.1, opportunistic: 0 },
  },
  growth: {
    label: "Growth",
    description:
      "Majority directional. Expect drawdowns in the tens of percent — this posture is only honest with money you can leave alone for years.",
    weights: {
      core: 0.25,
      accumulation: 0.35,
      systematic: 0.2,
      opportunistic: 0.05,
      "fx-trend": 0.05,
      "fx-carry": 0.05,
    },
  },
  aggressive: {
    label: "Aggressive",
    description:
      "Weighted hard toward the directional sleeves. Targets roughly 40–80% a year and expects 35–45% drawdowns, with losing streaks measured in months. Only defensible with money whose loss would change nothing about your life.",
    weights: {
      core: 0.15,
      accumulation: 0.3,
      systematic: 0.35,
      opportunistic: 0.12,
      "fx-trend": 0.05,
      "fx-carry": 0,
    },
  },
};

export function applyPreset(
  navUsd: number,
  presetId: keyof typeof PRESETS,
  current: SleeveAllocation[],
): SleeveAllocation[] {
  const preset = PRESETS[presetId];
  return SLEEVES.map((def) => {
    const w = preset.weights[def.id] ?? 0;
    const existing = current.find((c) => c.sleeveId === def.id);
    return {
      sleeveId: def.id,
      allocatedUsd: navUsd * w,
      enabled: w > 0,
      halted: existing?.halted ?? false,
    };
  });
}
