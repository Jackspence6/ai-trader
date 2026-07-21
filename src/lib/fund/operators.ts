/**
 * The fund and the people who operate it.
 *
 * **Musket Goose owns the capital.** There is one owner and no fractional
 * stakes — the people below are *operators*, not shareholders. They can record
 * capital movements, halt trading, and change configuration, and every such
 * action is attributed to them **for audit**, never for ownership.
 *
 * This supersedes DESIGN.md §7, which modelled several operators each holding
 * units of a pooled NAV. That design solves a real problem — when people
 * contribute different amounts at different times, percentage splits become
 * wrong fast — but it is the wrong problem here. With a single owner there is
 * nothing to divide, and a per-person ownership table would imply a claim that
 * does not exist.
 *
 * What survives from that model is the unit *series*, repurposed: with units
 * changing only on deposits and withdrawals, NAV per unit is a time-weighted
 * performance index. It separates "we made money" from "we added money", which
 * is the one thing a raw balance cannot tell you. See `ledger.ts`.
 */

export const FUND = {
  name: "Musket Goose",
  /** One owner, no fractional stakes. */
  ownership: "wholly owned" as const,
  /** Trading decisions come from rules and models, not from a person. */
  decisionMaker: "systematic — rules and models, no discretionary trading",
};

export type Operator = {
  id: string;
  name: string;
  initials: string;
  /** Colour token, for attributing actions in the audit trail. */
  colorVar: string;
};

/**
 * People authorised to operate the system.
 *
 * Listed so actions can be attributed, not so capital can be divided.
 */
export const OPERATORS: Operator[] = [
  { id: "js", name: "Jack Spence", initials: "JS", colorVar: "--color-s1" },
  { id: "fm", name: "Finn Mclaughlin", initials: "FM", colorVar: "--color-s3" },
  { id: "lk", name: "Lourens Kok", initials: "LK", colorVar: "--color-s4" },
  { id: "ns", name: "Nic Struwig", initials: "NS", colorVar: "--color-s2" },
];

export function operatorById(id: string): Operator | undefined {
  return OPERATORS.find((o) => o.id === id);
}
