/**
 * The fund.
 *
 * **Musket Goose owns the capital outright.** There are no fractional stakes,
 * no members, and no per-person accounting — one balance, one owner.
 *
 * This supersedes DESIGN.md §7, which modelled several operators each holding
 * units of a pooled NAV. That design solves a real problem (percentage splits
 * go wrong when people contribute different amounts at different times) and it
 * is not the problem here.
 *
 * **Why there is no "recorded by" field either.** An earlier version attributed
 * each capital event to a named person picked from a dropdown. Without
 * authentication that name is self-selected and unverified — it has the
 * appearance of an audit trail without the substance, which is worse than
 * having none, because it invites trust it cannot support. Real attribution
 * arrives with real sessions; until then events are recorded against the fund.
 *
 * What survives from the unit model, repurposed, is the performance index — see
 * `ledger.ts`.
 */

export const FUND = {
  name: "Musket Goose",
  /** One owner, no fractional stakes, no members. */
  ownership: "wholly owned" as const,
  /** Trading decisions come from rules and models, not from a person. */
  decisionMaker: "systematic — rules and models, no discretionary trading",
};
