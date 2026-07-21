/**
 * Venue environments — the boundary between practice and real money.
 *
 * The whole safety argument of this module rests on one property: **testnet and
 * mainnet run the identical code path, differing only in base URL.** That is
 * what makes testnet meaningful evidence rather than a separate toy — if the
 * order construction, signing, precision handling and error paths were
 * different, proving them on testnet would prove nothing about mainnet.
 *
 * It also means one mistyped constant could point practice orders at real
 * money. So mainnet is gated three ways, and all three must agree:
 *
 *   1. The credential itself must be stored as `mainnet`.
 *   2. `ALLOW_MAINNET_TRADING=true` must be set in the environment.
 *   3. The caller must pass `confirmMainnet: true` explicitly at the call site.
 *
 * Any one of those missing refuses the order. Three independent gates because
 * this is the one failure in the system that spends real money by accident, and
 * a single boolean is one typo away from being wrong.
 */

export type VenueEnvironment = "testnet" | "mainnet";

export type VenueFamily = "binance" | "bybit";

export type VenueEndpoint = {
  id: string;
  label: string;
  family: VenueFamily;
  environment: VenueEnvironment;
  /** Spot REST base. */
  spotBase: string;
  /** Perp/futures REST base. Same host as spot on Bybit, different on Binance. */
  perpBase: string;
  /** Where to get keys for this environment. Shown in the UI. */
  keySource: string;
};

export const VENUE_ENDPOINTS: Record<string, VenueEndpoint> = {
  "binance-testnet": {
    id: "binance-testnet",
    label: "Binance Testnet",
    family: "binance",
    environment: "testnet",
    spotBase: "https://testnet.binance.vision",
    // Binance runs spot and futures testnets as entirely separate systems with
    // separate keys and separate balances. A key from one does not work on the
    // other, and the error it returns does not say so.
    perpBase: "https://testnet.binancefuture.com",
    keySource: "testnet.binance.vision (spot) and testnet.binancefuture.com (futures) — separate keys",
  },
  "bybit-testnet": {
    id: "bybit-testnet",
    label: "Bybit Testnet",
    family: "bybit",
    environment: "testnet",
    spotBase: "https://api-testnet.bybit.com",
    perpBase: "https://api-testnet.bybit.com",
    keySource: "testnet.bybit.com → API management",
  },
  "binance-mainnet": {
    id: "binance-mainnet",
    label: "Binance",
    family: "binance",
    environment: "mainnet",
    spotBase: "https://api.binance.com",
    perpBase: "https://fapi.binance.com",
    keySource: "binance.com → API management (trade-only, no withdrawals, IP allowlisted)",
  },
  "bybit-mainnet": {
    id: "bybit-mainnet",
    label: "Bybit",
    family: "bybit",
    environment: "mainnet",
    spotBase: "https://api.bybit.com",
    perpBase: "https://api.bybit.com",
    keySource: "bybit.com → API management (trade-only, no withdrawals, IP allowlisted)",
  },
};

export function endpointFor(id: string): VenueEndpoint {
  const e = VENUE_ENDPOINTS[id];
  if (!e) throw new Error(`Unknown venue endpoint: ${id}`);
  return e;
}

/** Endpoints safe to trade without any further confirmation. */
export function testnetEndpoints(): VenueEndpoint[] {
  return Object.values(VENUE_ENDPOINTS).filter((e) => e.environment === "testnet");
}

export type MainnetGate =
  | { allowed: true }
  | { allowed: false; reason: string; failedGate: 1 | 2 | 3 };

/**
 * Check all three mainnet gates.
 *
 * Returns which gate failed, because "mainnet trading is disabled" is not
 * actionable — the operator needs to know whether to change the credential, the
 * environment, or the call.
 */
export function checkMainnetGate(
  endpoint: VenueEndpoint,
  credentialEnvironment: VenueEnvironment,
  confirmMainnet: boolean,
): MainnetGate {
  if (endpoint.environment === "testnet") return { allowed: true };

  if (credentialEnvironment !== "mainnet") {
    return {
      allowed: false,
      failedGate: 1,
      reason:
        "Credential is not marked as a mainnet key. Testnet keys do not work on mainnet, and a mismatch here means the wrong environment was selected.",
    };
  }

  if (process.env.ALLOW_MAINNET_TRADING !== "true") {
    return {
      allowed: false,
      failedGate: 2,
      reason:
        "ALLOW_MAINNET_TRADING is not set to 'true'. Real-money trading is off at the environment level and must be enabled deliberately, on the machine that will do the trading.",
    };
  }

  if (!confirmMainnet) {
    return {
      allowed: false,
      failedGate: 3,
      reason:
        "The call site did not pass confirmMainnet. Real-money orders must be explicit at the point they are placed, not inherited from configuration.",
    };
  }

  return { allowed: true };
}

/** True when this process is permitted to trade real money at all. */
export function mainnetEnabledInEnvironment(): boolean {
  return process.env.ALLOW_MAINNET_TRADING === "true";
}
