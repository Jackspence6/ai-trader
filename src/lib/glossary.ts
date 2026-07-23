/**
 * The glossary — plain-English explanations behind every ⓘ in the UI.
 *
 * The operators are not finance professionals, and the dashboard should
 * never require them to be. Every piece of jargon that appears on a screen
 * gets an entry here; the Info component renders it as a hover/tap tip.
 * One place, so a term is explained the same way everywhere.
 */

export const GLOSSARY: Record<string, string> = {
  nav: "Net Asset Value — the total worth of the fund right now: cash plus the current value of every open position.",
  allocated:
    "Money assigned to this portfolio's strategies. Allocated money isn't spent — it's the budget its strategies may trade with.",
  deployed:
    "How much of the allocated money is currently tied up inside open trades (including margin backing them).",
  available:
    "Allocated money not currently tied up in trades — the room left for new positions.",
  reserve:
    "NAV that isn't allocated to any portfolio. A deliberate buffer, not idle money.",
  income:
    "Money the positions have EARNED while being held — funding payments and interest-rate carry. The steady drip these strategies exist for.",
  realised:
    "Profit or loss that is locked in — from trades that have been closed. This number can't change any more.",
  unrealised:
    "Profit or loss on OPEN positions at current prices. It moves with the market until the position closes.",
  fees: "What we paid exchanges to enter and exit trades. Every trade starts this much behind.",
  drawdown:
    "How far below its highest-ever value this book has fallen, in percent. The charter halts a portfolio automatically if it falls too far.",
  chartercap:
    "The maximum share of total capital this portfolio is allowed to hold, set in the governance charter. Keeps any one book from dominating.",
  winrate: "The share of closed trades that made money.",
  profitfactor:
    "Total money won divided by total money lost. Above 1 means the wins outweigh the losses.",
  sharpe:
    "Return per unit of risk taken. Rough guide: below 0 losing, ~1 decent, 2+ excellent.",
  notional:
    "The full market value a position controls — what the trade is 'worth' in the market, regardless of the margin behind it.",
  carry:
    "A strategy that earns a steady payment for holding a position — like interest. Crypto perps pay 'funding' between traders; currencies pay interest-rate differences.",
  funding:
    "A payment exchanged every few hours between long and short traders in perpetual futures. When it's positive, shorts get paid — our carry trades collect it.",
  delta_neutral:
    "Holding offsetting positions (e.g. own the coin, short its future) so price moves cancel out — the position earns its income without betting on direction.",
  breakout:
    "Price closing above its highest level of the last N days — the trend strategy's signal that a move may be starting.",
  stop: "A pre-agreed exit that cuts a losing trade before it grows — the invalidation point where the idea is wrong.",
  persistence:
    "The ML model's estimate of the chance that a funding regime keeps paying for another week — used to grade and (once proven) veto weak entries.",
  tier: "The capital ladder level. Higher tiers unlock more strategies and positions, and are earned by holding NAV above a threshold for 7 days.",
  shadow:
    "Running with no money: the strategy is scored and recorded exactly as if trading, so it can build evidence before any capital is risked.",
  spreadl2:
    "The gap between funding rates on two exchanges for the same asset — theoretically harvestable by going short on one and long on the other.",
  basis:
    "The gap between a dated future's price and today's spot price. It shrinks to zero at expiry, mechanically — the trade captures that convergence.",
  equity:
    "Allocation plus everything this book has made or lost — what it's actually worth right now.",
  revalidation:
    "Every strategy is automatically re-run against fresh market history twice a day, using the exact same code that trades live. A strategy that stops earning in the replay gets flagged here before it can quietly bleed the live book.",
  health:
    "The automated verdict from the latest re-validation. HEALTHY earns after costs; WATCH is earning but weakly, thinly, or less than half of what it earned last check; FAILING loses after costs and should not hold capital.",
};

export type GlossaryKey = keyof typeof GLOSSARY;
