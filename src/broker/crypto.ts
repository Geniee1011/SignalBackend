import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

/* Symmetric encryption for broker credentials at rest (Tradovate password + API
   secret). AES-256-GCM (authenticated); the 32-byte key is derived from
   BROKER_ENC_KEY via SHA-256 so any passphrase length works.
   Stored format: "v1.<iv>.<tag>.<ciphertext>" (all base64).

   Deliberately the same construction as the trading platform's
   `market-data/secret-crypto.ts` — one reviewed approach to secrets at rest
   across both services rather than a second, subtly different one. */

function keyBuf(secret: string): Buffer {
  return createHash("sha256").update(secret).digest(); // 32 bytes
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuf(config.brokerEncKey), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/** Decrypt a blob from encryptSecret. null on any tamper/format/wrong-key error. */
export function decryptSecret(blob: string): string | null {
  try {
    const [v, ivB64, tagB64, encB64] = blob.split(".");
    if (v !== "v1" || !ivB64 || !tagB64 || !encB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyBuf(config.brokerEncKey), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Credentials can't be stored safely without a key — refuse rather than store plaintext. */
export const brokerCryptoReady = (): boolean => config.brokerEncKey.length > 0;
