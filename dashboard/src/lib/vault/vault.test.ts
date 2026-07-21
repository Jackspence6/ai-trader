/**
 * Tests for the credential vault.
 *
 * Three properties are worth more than the rest combined, and each has a test
 * that would fail loudly if it broke:
 *
 *   1. Tampered ciphertext is refused, not silently mis-decrypted.
 *   2. Secrets never appear in anything the store returns for display.
 *   3. The withdrawal check fails CLOSED — an ambiguous or missing permission
 *      flag blocks the key rather than allowing it.
 *
 * Signing is asserted against each venue's published documentation example,
 * which is the only way to know the implementation is right without a live key.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprint, hasMasterKey, open, safeEqual, seal, VaultError } from "./crypto";
import { binanceQuery, signBinance, signBybit } from "./sign";

const KEY = "test-master-key-not-a-real-one-0123456789";

/* -------------------------------------------------------------- crypto */

describe("vault crypto", () => {
  it("round-trips a secret", () => {
    const secret = "sUp3rS3cr3t-api-key-material";
    expect(open(seal(secret, KEY), KEY)).toBe(secret);
  });

  it("produces different ciphertext each time for the same plaintext", () => {
    // A fresh nonce and salt per encryption. Identical ciphertexts would mean
    // a reused nonce, which under GCM leaks the XOR of plaintexts and breaks
    // authentication entirely.
    const a = seal("same", KEY);
    const b = seal("same", KEY);
    expect(a.ct).not.toBe(b.ct);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.salt).not.toBe(b.salt);
  });

  it("refuses the wrong master key rather than returning garbage", () => {
    const sealed = seal("secret", KEY);
    expect(() => open(sealed, "a-completely-different-master-key")).toThrow(VaultError);
  });

  it("detects tampered ciphertext", () => {
    const sealed = seal("secret", KEY);
    const bytes = Buffer.from(sealed.ct, "base64");
    bytes[0] ^= 0xff;
    expect(() => open({ ...sealed, ct: bytes.toString("base64") }, KEY)).toThrow(
      VaultError,
    );
  });

  it("detects a tampered authentication tag", () => {
    const sealed = seal("secret", KEY);
    const tag = Buffer.from(sealed.tag, "base64");
    tag[0] ^= 0xff;
    expect(() => open({ ...sealed, tag: tag.toString("base64") }, KEY)).toThrow(
      VaultError,
    );
  });

  it("detects a swapped nonce", () => {
    const a = seal("secret one", KEY);
    const b = seal("secret two", KEY);
    expect(() => open({ ...a, nonce: b.nonce }, KEY)).toThrow(VaultError);
  });

  it("rejects an unknown record version", () => {
    const sealed = seal("secret", KEY);
    expect(() =>
      open({ ...sealed, v: 2 as unknown as 1 }, KEY),
    ).toThrow(/Unsupported vault record version/);
  });

  it("gives the same error for a wrong key and for tampering", () => {
    // Distinguishing them would tell an attacker "right key, wrong data",
    // which is more than they need to know.
    const sealed = seal("secret", KEY);
    const bytes = Buffer.from(sealed.ct, "base64");
    bytes[0] ^= 0xff;

    let wrongKey = "";
    let tampered = "";
    try {
      open(sealed, "another-master-key-entirely-here");
    } catch (e) {
      wrongKey = (e as Error).message;
    }
    try {
      open({ ...sealed, ct: bytes.toString("base64") }, KEY);
    } catch (e) {
      tampered = (e as Error).message;
    }
    expect(wrongKey).toBe(tampered);
  });

  it("requires a master key of reasonable length", () => {
    const prev = process.env.VAULT_KEY;
    try {
      delete process.env.VAULT_KEY;
      expect(hasMasterKey()).toBe(false);
      process.env.VAULT_KEY = "short";
      expect(hasMasterKey()).toBe(false);
      process.env.VAULT_KEY = KEY;
      expect(hasMasterKey()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VAULT_KEY;
      else process.env.VAULT_KEY = prev;
    }
  });

  it("fingerprints without revealing the key", () => {
    const key = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const fp = fingerprint(key);
    expect(fp).toBe("AbCd…6789");
    expect(fp.length).toBeLessThan(12);
    expect(key).not.toBe(fp);
  });

  it("masks a short key entirely", () => {
    expect(fingerprint("abc")).toBe("•••");
  });

  it("compares in constant time without leaking length mismatches as throws", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

/* ------------------------------------------------------------- signing */

describe("request signing", () => {
  it("matches Binance's published example exactly", () => {
    // From Binance's own API documentation. If this fails, every signed
    // request we make is rejected with a generic auth error that gives no
    // hint the signature is the problem.
    const secret =
      "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const qs =
      "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(signBinance(qs, secret)).toBe(
      "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71",
    );
  });

  it("appends recvWindow, timestamp and signature in a stable order", () => {
    const qs = binanceQuery({ symbol: "BTCUSDT" }, "secret", 1700000000000);
    expect(qs).toMatch(
      /^symbol=BTCUSDT&recvWindow=5000&timestamp=1700000000000&signature=[a-f0-9]{64}$/,
    );
  });

  it("signs exactly the string it emits", () => {
    // The signature covers the query string as transmitted. Rebuilding the
    // string after signing produces a valid-looking request the venue rejects.
    const built = binanceQuery({ a: "1", b: "2" }, "secret", 123);
    const [payload, sig] = built.split("&signature=");
    expect(signBinance(payload, "secret")).toBe(sig);
  });

  it("url-encodes parameter values", () => {
    const qs = binanceQuery({ note: "a b&c" }, "secret", 1);
    expect(qs).toContain("note=a%20b%26c");
  });

  it("concatenates Bybit's payload in the documented order", () => {
    // timestamp + apiKey + recvWindow + payload, no separators. Getting this
    // order wrong is the usual Bybit signing bug and fails identically to a
    // bad secret.
    const expected = createHmac("sha256", "sec")
      .update("1700000000000" + "KEY" + "5000" + "accountType=UNIFIED")
      .digest("hex");
    expect(signBybit(1700000000000, "KEY", 5000, "accountType=UNIFIED", "sec")).toBe(
      expected,
    );
  });
});

/* --------------------------------------------------------------- store */

describe("credential store", () => {
  let tmp: string;
  let prevVault: string | undefined;
  let prevKey: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vault-"));
    prevVault = process.env.VAULT_PATH;
    prevKey = process.env.VAULT_KEY;
    process.env.VAULT_PATH = path.join(tmp, "credentials.json");
    process.env.VAULT_KEY = KEY;
  });

  afterEach(async () => {
    if (prevVault === undefined) delete process.env.VAULT_PATH;
    else process.env.VAULT_PATH = prevVault;
    if (prevKey === undefined) delete process.env.VAULT_KEY;
    else process.env.VAULT_KEY = prevKey;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const load = () => import("./store");

  it("stores a credential and returns metadata only", async () => {
    const { add } = await load();
    const r = await add({
      venue: "binance",
      label: "Main",
      apiKey: "MYAPIKEY1234567890",
      apiSecret: "MYSECRET1234567890",
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The returned object must not carry the secret in any field.
    const serialised = JSON.stringify(r.credential);
    expect(serialised).not.toContain("MYAPIKEY1234567890");
    expect(serialised).not.toContain("MYSECRET1234567890");
    expect(r.credential.keyFingerprint).toBe("MYAP…7890");
  });

  it("never returns secrets from list()", async () => {
    const { add, list } = await load();
    await add({
      venue: "binance",
      label: "Main",
      apiKey: "SECRETKEYVALUE123",
      apiSecret: "SECRETSECRETVALUE",
    });

    const serialised = JSON.stringify(await list());
    expect(serialised).not.toContain("SECRETKEYVALUE123");
    expect(serialised).not.toContain("SECRETSECRETVALUE");
  });

  it("encrypts secrets at rest", async () => {
    const { add } = await load();
    await add({
      venue: "binance",
      label: "Main",
      apiKey: "PLAINTEXTKEY12345",
      apiSecret: "PLAINTEXTSECRET12",
    });

    const onDisk = await fs.readFile(process.env.VAULT_PATH!, "utf-8");
    expect(onDisk).not.toContain("PLAINTEXTKEY12345");
    expect(onDisk).not.toContain("PLAINTEXTSECRET12");
  });

  it("makes the vault file owner-only", async () => {
    const { add } = await load();
    await add({ venue: "binance", label: "M", apiKey: "k".repeat(20), apiSecret: "s".repeat(20) });
    const st = await fs.stat(process.env.VAULT_PATH!);
    expect(st.mode & 0o077).toBe(0);
  });

  it("hands secrets to a callback without returning them", async () => {
    const { add, withCredential, list } = await load();
    await add({
      venue: "binance",
      label: "Main",
      apiKey: "REALKEY1234567890",
      apiSecret: "REALSECRET1234567",
    });
    const [meta] = await list();

    const seen = await withCredential(meta.id, async (s) => ({
      key: s.apiKey,
      secret: s.apiSecret,
    }));
    expect(seen.key).toBe("REALKEY1234567890");
    expect(seen.secret).toBe("REALSECRET1234567");
  });

  it("adds credentials DISABLED until verified", async () => {
    const { add } = await load();
    const r = await add({
      venue: "binance",
      label: "Main",
      apiKey: "k".repeat(20),
      apiSecret: "s".repeat(20),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.credential.enabled).toBe(false);
    expect(r.credential.blockedReason).toMatch(/Not yet verified/);
  });

  it("BLOCKS a key with withdrawal permission and offers no override", async () => {
    // The highest-value control in the system. A key that can withdraw must be
    // unusable regardless of what else it can do.
    const { add, applyPermissions, list } = await load();
    await add({
      venue: "binance",
      label: "Dangerous",
      apiKey: "k".repeat(20),
      apiSecret: "s".repeat(20),
    });
    const [meta] = await list();

    const after = await applyPermissions(meta.id, {
      withdrawals: true,
      reading: true,
      spotTrading: true,
      futuresTrading: true,
      ipRestricted: true,
      checkedAt: Date.now(),
    });

    expect(after!.enabled).toBe(false);
    expect(after!.blockedReason).toMatch(/withdrawal permission/i);
    expect(after!.blockedReason).toMatch(/cannot be overridden/i);
  });

  it("enables a trade-only key", async () => {
    const { add, applyPermissions, list, enabledCredentials } = await load();
    await add({
      venue: "binance",
      label: "Safe",
      apiKey: "k".repeat(20),
      apiSecret: "s".repeat(20),
    });
    const [meta] = await list();

    const after = await applyPermissions(meta.id, {
      withdrawals: false,
      reading: true,
      spotTrading: true,
      futuresTrading: false,
      ipRestricted: true,
      checkedAt: Date.now(),
    });

    expect(after!.enabled).toBe(true);
    expect(after!.blockedReason).toBeNull();
    expect(await enabledCredentials()).toHaveLength(1);
  });

  it("warns, but still enables, when no IP allowlist is set", async () => {
    const { add, applyPermissions, list } = await load();
    await add({ venue: "binance", label: "S", apiKey: "k".repeat(20), apiSecret: "s".repeat(20) });
    const [meta] = await list();
    const after = await applyPermissions(meta.id, {
      withdrawals: false,
      reading: true,
      spotTrading: true,
      futuresTrading: false,
      ipRestricted: false,
      checkedAt: Date.now(),
    });
    expect(after!.enabled).toBe(true);
    expect(after!.blockedReason).toMatch(/IP allowlist/i);
  });

  it("blocks a key that cannot even read", async () => {
    const { add, applyPermissions, list } = await load();
    await add({ venue: "binance", label: "S", apiKey: "k".repeat(20), apiSecret: "s".repeat(20) });
    const [meta] = await list();
    const after = await applyPermissions(meta.id, {
      withdrawals: false,
      reading: false,
      spotTrading: false,
      futuresTrading: false,
      ipRestricted: true,
      checkedAt: Date.now(),
    });
    expect(after!.enabled).toBe(false);
  });

  it("refuses a duplicate key for the same venue", async () => {
    const { add } = await load();
    const input = {
      venue: "binance" as const,
      label: "A",
      apiKey: "DUPLICATE12345678",
      apiSecret: "s".repeat(20),
    };
    expect((await add(input)).ok).toBe(true);
    const second = await add({ ...input, label: "B" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already stored/);
  });

  it("rejects empty key or secret", async () => {
    const { add } = await load();
    expect((await add({ venue: "binance", label: "x", apiKey: "", apiSecret: "s" })).ok).toBe(
      false,
    );
    expect((await add({ venue: "binance", label: "x", apiKey: "k", apiSecret: "  " })).ok).toBe(
      false,
    );
  });

  it("removes a credential", async () => {
    const { add, remove, list } = await load();
    await add({ venue: "binance", label: "X", apiKey: "k".repeat(20), apiSecret: "s".repeat(20) });
    const [meta] = await list();
    expect(await remove(meta.id)).toBe(true);
    expect(await list()).toHaveLength(0);
    expect(await remove(meta.id)).toBe(false);
  });

  it("returns an empty list when no vault file exists", async () => {
    const { list } = await load();
    expect(await list()).toEqual([]);
  });
});

/* --------------------------------------------------- marking to USD */

describe("marking balances to USD", () => {
  it("prices stablecoins at 1 and everything else from the price map", async () => {
    const { markToUsd } = await import("./venues");
    const r = markToUsd(
      [
        { asset: "USDT", free: 100, locked: 0, total: 100 },
        { asset: "BTC", free: 0.5, locked: 0, total: 0.5 },
      ],
      new Map([["BTC", 60000]]),
    );
    expect(r.totalUsd).toBe(100 + 30000);
    expect(r.unpriced).toEqual([]);
  });

  it("reports assets it could not price rather than valuing them at zero", async () => {
    // Silently treating an unpriced asset as worthless understates NAV, which
    // then understates every limit derived from it.
    const { markToUsd } = await import("./venues");
    const r = markToUsd(
      [{ asset: "WEIRDCOIN", free: 10, locked: 0, total: 10 }],
      new Map(),
    );
    expect(r.unpriced).toEqual(["WEIRDCOIN"]);
    expect(r.totalUsd).toBe(0);
  });
});
