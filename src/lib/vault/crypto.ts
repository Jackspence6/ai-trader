/**
 * Credential encryption.
 *
 * AES-256-GCM via `node:crypto`, with the master key derived by scrypt.
 *
 * **Deviation from DESIGN.md §2, deliberately.** The design specifies libsodium
 * sealed boxes. Sealed boxes are *asymmetric* — they let a writer encrypt to a
 * public key without being able to decrypt, which is a genuinely valuable
 * property when the component that stores a credential is separate from the one
 * that uses it. Today the same process does both, so the asymmetry buys nothing
 * and costs a native dependency. AES-256-GCM is authenticated encryption of
 * equivalent strength with zero dependencies.
 *
 * When the engine splits from the dashboard (ROADMAP phase A4), revisit this:
 * at that point the dashboard should be able to write a credential it cannot
 * read, and sealed boxes become the right primitive.
 *
 * Properties this file guarantees:
 *   - Ciphertext is authenticated. Tampering fails loudly rather than
 *     decrypting to garbage that gets sent to an exchange as an API key.
 *   - A unique random nonce per encryption. Nonce reuse under GCM is
 *     catastrophic — it leaks the XOR of plaintexts and breaks authentication —
 *     so it is generated fresh here and never derived from anything.
 *   - The master key never touches disk.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12; // 96 bits, the GCM standard
const SALT_LENGTH = 16;

export type SealedRecord = {
  /** Format version, so a later reader can migrate old records. */
  v: 1;
  /** Base64 scrypt salt. Stored per-record so keys are not shared across them. */
  salt: string;
  /** Base64 GCM nonce. Unique per encryption, never reused. */
  nonce: string;
  /** Base64 ciphertext. */
  ct: string;
  /** Base64 GCM authentication tag. */
  tag: string;
};

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * The master key, from the environment.
 *
 * Never persisted by this system. In production it comes from the OS keychain
 * or the systemd credential store; in development, from a `.env` file that is
 * gitignored.
 *
 * A missing key is a hard error rather than a generated default. Generating one
 * silently would encrypt credentials under a key that vanishes on restart,
 * which looks like it worked right up until nothing can be decrypted.
 */
export function masterKeyMaterial(): string {
  const key = process.env.VAULT_KEY;
  if (!key || key.length < 16) {
    throw new VaultError(
      "VAULT_KEY is not set (or is shorter than 16 characters). " +
        "Generate one with:  openssl rand -base64 32\n" +
        "Then export it, or put it in .env.local — never in the repo.",
    );
  }
  return key;
}

/** Whether a usable master key is present, without throwing. */
export function hasMasterKey(): boolean {
  try {
    masterKeyMaterial();
    return true;
  } catch {
    return false;
  }
}

function deriveKey(material: string, salt: Buffer): Buffer {
  // scrypt with N=2^15. Deliberately slow: the threat model is an attacker with
  // the encrypted file trying to brute-force a weak master key, and the cost
  // per attempt is the only defence against that.
  return scryptSync(material, salt, KEY_LENGTH, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function seal(plaintext: string, material = masterKeyMaterial()): SealedRecord {
  const salt = randomBytes(SALT_LENGTH);
  const nonce = randomBytes(NONCE_LENGTH);
  const key = deriveKey(material, salt);

  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    v: 1,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function open(record: SealedRecord, material = masterKeyMaterial()): string {
  if (record.v !== 1) {
    throw new VaultError(`Unsupported vault record version ${record.v}`);
  }

  const salt = Buffer.from(record.salt, "base64");
  const nonce = Buffer.from(record.nonce, "base64");
  const key = deriveKey(material, salt);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(record.ct, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM authentication failed: either the wrong master key, or the file was
    // modified. Both are refusals, and neither should say which — telling an
    // attacker "right key, wrong data" is more information than they need.
    throw new VaultError(
      "Could not decrypt credential — wrong VAULT_KEY, or the vault file has been modified.",
    );
  }
}

/**
 * A non-secret fingerprint of an API key, for display.
 *
 * Shows enough to tell two keys apart on screen and nothing more. The dashboard
 * writes credentials but never renders them back (DESIGN.md §6), and this is
 * what it renders instead.
 */
export function fingerprint(apiKey: string): string {
  if (apiKey.length <= 8) return "•".repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

/** Constant-time string comparison, for anything secret-adjacent. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
