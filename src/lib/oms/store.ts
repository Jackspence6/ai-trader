/**
 * Order and fill persistence.
 *
 * Append-only through the shared KV layer, so the book lives in Postgres when
 * `DATABASE_URL` is set and in JSONL otherwise. Append-only either way: crash
 * safety, trivial inspection, and nothing is ever rewritten.
 *
 * Positions are NOT stored. They are derived by replaying fills every time
 * (see `portfolio/positions.ts`). Storing them would create a second source of
 * truth that can drift from the fill log — and a cached position that disagrees
 * with its own fills is exactly how a trading system ends up confidently wrong
 * about what it holds.
 */

import { appendLog, clearLog, LOGS, readLog } from "@/lib/store/kv";
import type { Fill, FundingPayment } from "@/lib/portfolio/positions";
import type { Order } from "./types";

export type PaperStream = "orders" | "fills" | "funding";

const STREAM_KEY: Record<PaperStream, string> = {
  orders: LOGS.orders,
  fills: LOGS.fills,
  funding: LOGS.funding,
};

export const recordOrders = (orders: Order[]) => appendLog(STREAM_KEY.orders, orders);
export const recordFills = (fills: Fill[]) => appendLog(STREAM_KEY.fills, fills);
export const recordFunding = (payments: FundingPayment[]) =>
  appendLog(STREAM_KEY.funding, payments);

export const readOrders = () => readLog<Order>(STREAM_KEY.orders);
export const readFills = () => readLog<Fill>(STREAM_KEY.fills);
export const readFundingPayments = () => readLog<FundingPayment>(STREAM_KEY.funding);

/** Wipe the paper book. Only ever used deliberately — hence the explicit name. */
export async function resetPaperBook(): Promise<void> {
  await Promise.all(Object.values(STREAM_KEY).map((k) => clearLog(k)));
}
