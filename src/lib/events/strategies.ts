/**
 * The Event Markets playbook.
 *
 * One entry per edge this desk can trade, each carrying its standing and the
 * measurement that earned it. The standings are deliberately the same words the
 * Asset Markets desk uses, plus the two that desk has never needed:
 *
 *   funded      real money is allowed against it
 *   ready       built and verified, waiting on something outside the code
 *   measuring   running live and producing evidence, not yet funded
 *   scored      detected and priced, but the evidence says do not fund it
 *   unmeasured  the code exists and has never been pointed at live data
 *   unbuilt     not built
 *
 * `unmeasured` and `unbuilt` exist because the alternative is a screen that
 * quietly implies more than is true. A strategy card with no numbers on it reads
 * as "nothing happening lately" when it should read "nobody has ever run this".
 *
 * Every `evidence` line below is a real measurement with a date on it. Nothing
 * here is a projection, and anything that is a projection says so in words.
 */

export type Standing =
  | "funded"
  | "ready"
  | "measuring"
  | "scored"
  | "unmeasured"
  | "unbuilt";

export const STANDING_META: Record<
  Standing,
  { label: string; tone: "up" | "accent" | "warn" | "neutral" | "down"; blurb: string }
> = {
  funded: { label: "FUNDED", tone: "up", blurb: "Real money allowed" },
  ready: { label: "READY", tone: "accent", blurb: "Built and verified — blocked on something outside the code" },
  measuring: { label: "MEASURING", tone: "accent", blurb: "Running live, gathering evidence" },
  scored: { label: "SCORED", tone: "neutral", blurb: "Priced and watched, not funded" },
  unmeasured: { label: "NOT MEASURED", tone: "warn", blurb: "Code exists, never run against live data" },
  unbuilt: { label: "NOT BUILT", tone: "warn", blurb: "Nothing behind this yet" },
};

export type EventStrategy = {
  code: string;
  name: string;
  standing: Standing;
  /** What it is, for someone who does not do this for a living. */
  plain: string;
  /** The measurement that set the standing, with the date it was taken. */
  evidence: string;
  /** What would have to change for this to move up a rung. */
  next: string;
  /** Headline number and what it means, or null while there isn't one. */
  metric: { label: string; value: string; tone?: "up" | "down" | "neutral" } | null;
};

export const EVENT_STRATEGIES: EventStrategy[] = [
  {
    code: "E1",
    name: "Promotional hedging",
    standing: "ready",
    plain:
      "Sign-up bonuses carry a turnover requirement. Every qualifying bet is hedged on a second book, so the result of the match does not matter and the bonus survives the rollover. The cost is a known percentage of turnover; the bonus is the return.",
    evidence:
      "The only positive measured edge on this desk. At a typical 4% two-book overround, R2,000 of capital clears a R1,200 bonus for about R683 of expected value over ~60 hedged pairs, with roughly R82 ever at risk. Scales close to linearly down to R1,000 and up to the bonus cap.",
    next:
      "Blocked on real accounts and on re-verifying each promo's terms against the operator's own account — only WSB's deposit match is explicit in its own offer name.",
    metric: { label: "EV on R2,000", value: "R683", tone: "up" },
  },
  {
    code: "E2",
    name: "Cross-book arbitrage",
    standing: "measuring",
    plain:
      "The same match priced at two bookmakers. When the two books disagree enough that backing every outcome costs less than it returns, the difference is locked in before the match starts.",
    evidence:
      "2026-08-25, live: 38 events quoted by both Sunbet and Betway. Across 33 three-way books and 164 two-way books, zero arbitrage. The tightest three-way was −2.4%; the tightest two-way was Southampton v West Ham Over/Under 3.5 at −1.3%.",
    next:
      "Two books leave a ~1.3% gap on the best market on the board. Adding Hollywoodbets and Supabets is the direct attack on it — best-of-N tightens quickly.",
    metric: { label: "Best gap", value: "−1.3%", tone: "down" },
  },
  {
    code: "E3",
    name: "Book vs prediction market",
    standing: "unmeasured",
    plain:
      "A sportsbook price against the same outcome on a prediction market, where the prediction side is fee-adjusted to a true effective price before comparison.",
    evidence:
      "Never run. Both sides exist and are tested in isolation — the fee model and the effective-odds conversion are covered by the cross-language parity suite — but the two have never been pointed at each other on live data.",
    next:
      "Sunbet carries 183 American-football events and the prediction side is heavily NFL, so the overlap is real. This is a measurement waiting to be taken, not a feature waiting to be built.",
    metric: null,
  },
  {
    code: "E4",
    name: "Prediction-market internal",
    standing: "scored",
    plain:
      "Both sides of a binary market on one venue, or a complete set of mutually exclusive outcomes. If the whole set costs less than it must pay out, the difference is riskless.",
    evidence:
      "Measured and empty. A full scan read 440 markets across 29 events with zero parse errors and found no arbitrage. A direct probe of the tightest books put them at 1.0010 raw — about 0.1% inside the line before the taker fee is applied at all.",
    next:
      "Nothing. This is a validated negative, not a gap: the scanner works and the market is efficient. It stays running because spreads move, and it costs nothing to keep watching.",
    metric: { label: "Tightest book", value: "1.0010", tone: "neutral" },
  },
  {
    code: "E5",
    name: "Placement and settlement",
    standing: "unbuilt",
    plain:
      "Recording what was actually placed, at what price, and what it settled to — so scored opportunities can be compared against caught ones.",
    evidence:
      "The schema exists and the board can record an outcome by hand, but nothing has been placed, so the capture-rate measurement has no data behind it yet.",
    next:
      "This is what decides whether the desk is viable at all: the specification's own benchmark is that if manual capture on live arbitrage lands under 30%, promotional hedging is the primary edge and cross-book arbitrage is a research project.",
    metric: null,
  },
];
