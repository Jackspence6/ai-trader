/**
 * Engine configuration — every threshold the operator can tune.
 *
 * These are the knobs the Control screen edits. They are deliberately kept in
 * one flat, serialisable object with documented defaults so that:
 *   - the same object can be diffed and audit-logged on every change,
 *   - a bad configuration can be reverted to `DEFAULT_CONFIG` in one action,
 *   - and the scanner has no hidden constants buried in its logic.
 *
 * Every default below is chosen to be *conservative*. It is much cheaper to
 * loosen a threshold after seeing shadow-mode evidence than to discover a loose
 * one was quietly bleeding capital.
 */

export type EngineConfig = {
  /* -------------------------------------------------- capital & operation */

  /**
   * Live NAV in USD.
   *
   * Zero until real exchange accounts are linked — and it stays zero rather
   * than being seeded with a plausible number. A trading dashboard showing
   * invented capital is the single most dangerous kind of wrong.
   */
  navUsd: number;

  /** Master switch. When true nothing may trade, for any reason. */
  globalHalt: boolean;

  /**
   * Reference notional used to *score* opportunities while in shadow mode.
   *
   * Shadow scoring needs a size to compute fees and slippage against, but that
   * size must not pretend to be capital we have. This is explicitly labelled as
   * a hypothetical throughout the UI.
   */
  shadowNotionalUsd: number;

  /* -------------------------------------------------------------- economics */

  /** Minimum net edge, in bps, before an opportunity is worth acting on. */
  minNetEdgeBps: number;

  /**
   * Minimum annualised funding to consider a carry entry, as a fraction.
   *
   * 0.08 (8%) is the floor at which carry meaningfully beats doing nothing
   * after costs. Below it the position ties up capital and margin-management
   * attention for a return that a bad week erases.
   */
  minFundingApr: number;

  /**
   * How long we expect to hold a carry position, in days.
   *
   * This is the denominator that amortises entry costs, so it materially
   * changes which opportunities pass. 21 days reflects how long funding
   * regimes typically persist — not how long we would *like* to hold.
   */
  expectedHoldDays: number;

  /* ------------------------------------------------------------- risk shape */

  /** Leverage on the perp leg of a carry. 3x recovers 75% of headline APR. */
  perpLeverage: number;

  /** Hard cap the gate enforces regardless of what a strategy requests. */
  maxLeverage: number;

  /** Target size of one leg as a fraction of NAV. */
  legNotionalPctOfNav: number;

  /** Annualised portfolio volatility target, for directional sizing. */
  targetAnnualVol: number;

  /** Maximum fraction of NAV in any single position. */
  maxPositionPctOfNav: number;

  /* ---------------------------------------------------------- regime filter */

  /** How many funding prints to use when classifying the regime. */
  fundingRegimeWindow: number;

  /**
   * Minimum share of the window where funding was positive.
   *
   * The persistence filter. A single rich print is usually a liquidation
   * artefact that reverts within one interval; 0.7 requires funding to have
   * been positive in at least 70% of recent intervals before we treat it as a
   * regime worth entering.
   */
  minPositiveShare: number;

  /* -------------------------------------------------------------- integrity */

  /** Reject any decision made on data older than this. */
  maxDataAgeSeconds: number;

  /** Daily loss limit as a fraction of NAV — breach triggers a global halt. */
  dailyLossLimitPct: number;

  /** Max drawdown from high-water mark before halting, as a fraction. */
  maxDrawdownPct: number;
};

export const DEFAULT_CONFIG: EngineConfig = {
  navUsd: 0,
  globalHalt: false,
  shadowNotionalUsd: 1_000,

  minNetEdgeBps: 15,
  minFundingApr: 0.08,
  expectedHoldDays: 21,

  perpLeverage: 3,
  maxLeverage: 5,
  legNotionalPctOfNav: 0.2,
  targetAnnualVol: 0.1,
  maxPositionPctOfNav: 0.25,

  fundingRegimeWindow: 30,
  minPositiveShare: 0.7,

  maxDataAgeSeconds: 30,
  dailyLossLimitPct: 0.02,
  maxDrawdownPct: 0.08,
};

/** Bounds for every numeric field, enforced on save. */
export const CONFIG_BOUNDS: Record<
  string,
  { min: number; max: number; step: number; unit: string; label: string; help: string }
> = {
  navUsd: {
    min: 0,
    max: 10_000_000,
    step: 100,
    unit: "$",
    label: "Net asset value",
    help: "Live capital under management. Zero until exchange accounts are linked — the tier ladder reads this on every decision.",
  },
  shadowNotionalUsd: {
    min: 10,
    max: 1_000_000,
    step: 100,
    unit: "$",
    label: "Shadow reference size",
    help: "Hypothetical position size used to score opportunities before any capital exists. Affects fee and slippage estimates only.",
  },
  minNetEdgeBps: {
    min: 0,
    max: 500,
    step: 1,
    unit: "bp",
    label: "Minimum net edge",
    help: "Edge remaining after fees, spread, slippage and minimum-notional drag. Below this an opportunity is rejected.",
  },
  minFundingApr: {
    min: 0,
    max: 2,
    step: 0.01,
    unit: "%",
    label: "Minimum funding APR",
    help: "Annualised funding floor for a carry entry. Below roughly 8% the position is not worth the margin attention it demands.",
  },
  expectedHoldDays: {
    min: 0.5,
    max: 365,
    step: 0.5,
    unit: "d",
    label: "Expected hold",
    help: "Amortises entry cost. Longer holds make thin edges viable — but only if funding actually persists that long.",
  },
  perpLeverage: {
    min: 1,
    max: 20,
    step: 0.5,
    unit: "x",
    label: "Perp leg leverage",
    help: "Capital efficiency is L/(L+1): 3x recovers 75% of headline APR, 5x recovers 83%. Past that you buy little yield and move liquidation much closer.",
  },
  maxLeverage: {
    min: 1,
    max: 20,
    step: 0.5,
    unit: "x",
    label: "Leverage cap",
    help: "Hard ceiling the risk gate enforces regardless of what a strategy requests.",
  },
  legNotionalPctOfNav: {
    min: 0.01,
    max: 1,
    step: 0.01,
    unit: "%",
    label: "Leg size (% of NAV)",
    help: "Target notional for one leg of a position, as a share of NAV.",
  },
  targetAnnualVol: {
    min: 0.01,
    max: 1,
    step: 0.01,
    unit: "%",
    label: "Target volatility",
    help: "Annualised portfolio volatility target used to size directional positions so each contributes comparable risk.",
  },
  maxPositionPctOfNav: {
    min: 0.01,
    max: 1,
    step: 0.01,
    unit: "%",
    label: "Max position size",
    help: "Cap on any single position. Low measured volatility often precedes high volatility, so vol-targeting alone is not a sufficient limit.",
  },
  fundingRegimeWindow: {
    min: 5,
    max: 200,
    step: 1,
    unit: "",
    label: "Regime window",
    help: "Number of funding prints used to classify the regime. Scored on the median, so single spikes do not move it.",
  },
  minPositiveShare: {
    min: 0,
    max: 1,
    step: 0.05,
    unit: "%",
    label: "Funding persistence",
    help: "Minimum share of the window where funding was positive. This is the filter that separates a regime from a one-off liquidation artefact.",
  },
  maxDataAgeSeconds: {
    min: 1,
    max: 600,
    step: 1,
    unit: "s",
    label: "Max data age",
    help: "Any decision made on data older than this is rejected outright.",
  },
  dailyLossLimitPct: {
    min: 0.001,
    max: 0.5,
    step: 0.001,
    unit: "%",
    label: "Daily loss limit",
    help: "Loss in one day, as a share of NAV, that triggers a global halt.",
  },
  maxDrawdownPct: {
    min: 0.01,
    max: 0.9,
    step: 0.01,
    unit: "%",
    label: "Max drawdown",
    help: "Decline from the high-water mark that halts all trading.",
  },
};

/** Fields expressed as fractions but displayed as percentages. */
export const PERCENT_FIELDS = new Set([
  "minFundingApr",
  "legNotionalPctOfNav",
  "targetAnnualVol",
  "maxPositionPctOfNav",
  "minPositiveShare",
  "dailyLossLimitPct",
  "maxDrawdownPct",
]);

/**
 * Validate and clamp an incoming config.
 *
 * Never throws on a bad field — clamps it and reports what was changed. A
 * config save that silently half-applies is worse than one that visibly
 * corrects itself.
 */
export function sanitiseConfig(input: unknown): {
  config: EngineConfig;
  adjustments: string[];
} {
  const adjustments: string[] = [];
  const src = (input ?? {}) as Partial<Record<keyof EngineConfig, unknown>>;
  const out = { ...DEFAULT_CONFIG };

  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof EngineConfig)[]) {
    const raw = src[key];
    if (raw === undefined) continue;

    if (key === "globalHalt") {
      out.globalHalt = Boolean(raw);
      continue;
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) {
      adjustments.push(`${key}: not a number, kept default`);
      continue;
    }

    const b = CONFIG_BOUNDS[key];
    if (b) {
      const clamped = Math.min(Math.max(n, b.min), b.max);
      if (clamped !== n) adjustments.push(`${key}: ${n} clamped to ${clamped}`);
      (out[key] as number) = clamped;
    } else {
      (out[key] as number) = n;
    }
  }

  // Cross-field invariant: a strategy must never be able to request more
  // leverage than the gate permits.
  if (out.perpLeverage > out.maxLeverage) {
    adjustments.push(
      `perpLeverage ${out.perpLeverage}x exceeds cap, lowered to ${out.maxLeverage}x`,
    );
    out.perpLeverage = out.maxLeverage;
  }

  return { config: out, adjustments };
}
