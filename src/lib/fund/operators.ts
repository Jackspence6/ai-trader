/**
 * The operators of the fund.
 *
 * Ownership is tracked in units, not percentages — see `ledger.ts`. With
 * several people contributing different amounts at different times, raw
 * percentage splits become wrong very fast: if one operator adds capital right
 * before a good week, splitting the gain equally credits everyone for a return
 * only one of them funded.
 */

export type Operator = {
  id: string;
  name: string;
  initials: string;
  /** Series colour token for charts. Direct labels are still required. */
  colorVar: string;
};

export const OPERATORS: Operator[] = [
  { id: "js", name: "Jack Spence", initials: "JS", colorVar: "--color-s1" },
  { id: "fm", name: "Finn Mclaughlin", initials: "FM", colorVar: "--color-s3" },
  { id: "lk", name: "Lourens Kok", initials: "LK", colorVar: "--color-s4" },
  { id: "ns", name: "Nic Struwig", initials: "NS", colorVar: "--color-s2" },
];

export function operatorById(id: string): Operator | undefined {
  return OPERATORS.find((o) => o.id === id);
}
