/**
 * Order and fill persistence.
 *
 * Append-only JSONL, same as the recorder and for the same reasons: crash
 * safety, trivial inspection, and a straight replay into Postgres later.
 *
 * Positions are NOT stored. They are derived by replaying fills every time
 * (see `portfolio/positions.ts`). Storing them would create a second source of
 * truth that can drift from the fill log — and a cached position that disagrees
 * with its own fills is exactly how a trading system ends up confidently wrong
 * about what it holds.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Fill, FundingPayment } from "@/lib/portfolio/positions";
import type { Order } from "./types";

export type PaperStream = "orders" | "fills" | "funding";

function root(): string {
  return process.env.PAPER_DIR ?? path.join(process.cwd(), ".data", "paper");
}

function fileFor(stream: PaperStream): string {
  return path.join(root(), `${stream}.jsonl`);
}

async function append<T>(stream: PaperStream, rows: T[]): Promise<number> {
  if (rows.length === 0) return 0;
  await fs.mkdir(root(), { recursive: true });
  const payload = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.appendFile(fileFor(stream), payload, "utf-8");
  return rows.length;
}

async function readAll<T>(stream: PaperStream): Promise<T[]> {
  try {
    const raw = await fs.readFile(fileFor(stream), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as T;
        } catch {
          // A torn final line from a crash must not make the whole book
          // unreadable — and an unreadable fill log means unknown positions.
          return null;
        }
      })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

export const recordOrders = (orders: Order[]) => append("orders", orders);
export const recordFills = (fills: Fill[]) => append("fills", fills);
export const recordFunding = (payments: FundingPayment[]) => append("funding", payments);

export const readOrders = () => readAll<Order>("orders");
export const readFills = () => readAll<Fill>("fills");
export const readFundingPayments = () => readAll<FundingPayment>("funding");

/** Wipe the paper book. Only ever used deliberately — hence the explicit name. */
export async function resetPaperBook(): Promise<void> {
  await fs.rm(root(), { recursive: true, force: true });
}
