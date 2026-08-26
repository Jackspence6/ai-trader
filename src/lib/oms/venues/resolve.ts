/**
 * Which venue the trading loop actually trades against.
 *
 * There was a live adapter and there was a simulated one, and the loop was
 * hard-wired to the simulated one — `new SimulatedVenue()` inline, in the
 * middle of a pass. That is safe, but it is safe by accident: nothing said so,
 * nothing tested it, and the answer to "how do we go live" was "edit the engine".
 *
 * This is the single seam. Everything about which money is at risk is decided
 * here, and it fails closed at every step: no explicit opt-in, no credential,
 * no confirmed environment, or any doubt at all, and you get paper.
 *
 * The three mainnet gates in `environment.ts` still apply per order underneath
 * this. That is deliberate belt-and-braces — this function decides which venue
 * the loop holds, and the venue re-checks permission every time an order tries
 * to leave the process, so a long-lived venue object cannot keep a permission
 * that has since been revoked.
 */

import type { Venue } from "../types";
import { SimulatedVenue, type SimulatedVenueOptions } from "../simulated";
import { ExchangeVenue } from "./exchange";
import {
  endpointFor,
  mainnetEnabledInEnvironment,
  type VenueEnvironment,
} from "./environment";

export type VenueMode = "paper" | "testnet" | "live";

export type VenueResolution = {
  venue: Venue;
  mode: VenueMode;
  /** Plain-language reason this mode was chosen. Rendered in the UI and logged
   *  on every pass, so the answer to "why is this on paper?" is never a guess. */
  reason: string;
};

export type ResolveOptions = {
  /** Credential for the chosen endpoint, if one is configured. */
  credential?: {
    endpointId: string;
    apiKey: string;
    apiSecret: string;
    environment: VenueEnvironment;
  } | null;
  simulated?: SimulatedVenueOptions;
};

/**
 * `MERIDIAN_EXECUTION` is the deliberate step.
 *
 * Unset or anything unrecognised means paper. It is read here rather than
 * threaded through config because it must be a property of the machine doing
 * the trading, not of a settings row someone can change from a browser.
 */
function requestedMode(): VenueMode {
  const raw = (process.env.MERIDIAN_EXECUTION ?? "").trim().toLowerCase();
  if (raw === "live") return "live";
  if (raw === "testnet") return "testnet";
  return "paper";
}

export function resolveVenue(opts: ResolveOptions = {}): VenueResolution {
  const paper = (reason: string): VenueResolution => ({
    venue: new SimulatedVenue(opts.simulated),
    mode: "paper",
    reason,
  });

  const want = requestedMode();
  if (want === "paper") {
    return paper(
      "MERIDIAN_EXECUTION is not set to 'testnet' or 'live'. Paper is the default and has to be opted out of.",
    );
  }

  const cred = opts.credential;
  if (!cred) {
    return paper(
      `MERIDIAN_EXECUTION=${want} but no exchange credential is configured. Orders would have nowhere to go, so the loop stays on paper.`,
    );
  }

  let endpoint;
  try {
    endpoint = endpointFor(cred.endpointId);
  } catch {
    return paper(
      `MERIDIAN_EXECUTION=${want} but '${cred.endpointId}' is not a known venue endpoint.`,
    );
  }

  // A testnet credential cannot reach mainnet and vice versa. Catching the
  // mismatch here rather than at order time turns a rejected order into a
  // startup message.
  if (endpoint.environment !== cred.environment) {
    return paper(
      `The credential is marked ${cred.environment} but '${endpoint.id}' is a ${endpoint.environment} endpoint. Environment mismatches are refused rather than reconciled.`,
    );
  }

  if (want === "live") {
    if (endpoint.environment !== "mainnet") {
      return paper(
        `MERIDIAN_EXECUTION=live but '${endpoint.id}' is a testnet endpoint. Live means real money; pick a mainnet endpoint or set MERIDIAN_EXECUTION=testnet.`,
      );
    }
    if (!mainnetEnabledInEnvironment()) {
      return paper(
        "MERIDIAN_EXECUTION=live but ALLOW_MAINNET_TRADING is not 'true'. Both are required, on the machine that will trade, and neither implies the other.",
      );
    }
  }

  const venue = new ExchangeVenue({
    endpoint,
    apiKey: cred.apiKey,
    apiSecret: cred.apiSecret,
    credentialEnvironment: cred.environment,
    // Confirmation is per order and is the venue's own gate 3; the loop passing
    // it here would defeat the point of that gate existing.
    confirmMainnet: false,
  });

  return {
    venue,
    mode: endpoint.environment === "mainnet" ? "live" : "testnet",
    reason:
      endpoint.environment === "mainnet"
        ? `Real money. MERIDIAN_EXECUTION=live, ALLOW_MAINNET_TRADING=true, and a mainnet credential for '${endpoint.id}'.`
        : `Testnet. Orders reach a real exchange against simulated balances at '${endpoint.id}'.`,
  };
}

/** What the loop would do right now, without constructing anything. Used by the
 *  preflight check and by the UI so both read the same answer. */
export function describeExecutionMode(opts: ResolveOptions = {}): {
  mode: VenueMode;
  reason: string;
} {
  const { mode, reason } = resolveVenue(opts);
  return { mode, reason };
}
