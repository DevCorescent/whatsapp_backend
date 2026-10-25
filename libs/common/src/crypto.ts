import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENVELOPE_PREFIX = 'enc:v1:';
const ALGORITHM       = 'aes-256-gcm';
const IV_LENGTH       = 12;

function getKey(): Buffer | null {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) return null;
  return createHash('sha256').update(secret).digest();
}

/**
 * Mirror of lib/crypto.ts decryptSecret from the Next.js layer.
 * A value without the enc:v1: envelope is returned as-is (legacy plaintext).
 * Null/empty passes through. Returns null on decryption failure.
 */
export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith(ENVELOPE_PREFIX)) return trimmed;

  const key = getKey();
  if (!key) return null;

  try {
    const [ivB64, tagB64, dataB64] = trimmed.slice(ENVELOPE_PREFIX.length).split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8') || null;
  } catch {
    return null;
  }
}

/**
 * Encrypt a secret for storage. Returns the value unchanged when no key is
 * configured, so an unconfigured deployment stores plaintext rather than failing.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext?.trim()) return plaintext;
  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return (
    ENVELOPE_PREFIX +
    [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
  );
}

/**
 * Strip wrapping quotes, "Bearer " prefix, the enc:v1: envelope, and whitespace
 * from a pasted WhatsApp access token.
 */
export function sanitizeWhatsAppToken(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let t = raw.trim();
  if (!t) return null;

  if (
    (t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
    (t.startsWith("'") && t.endsWith("'") && t.length > 1)
  ) {
    t = t.slice(1, -1).trim();
  }

  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '').trim();
  if (t.startsWith(ENVELOPE_PREFIX)) return null;

  t = t.replace(/\s+/g, '');
  return t || null;
}

/** Meta Graph API tokens start with EAA and are long. */
export function isMetaAccessToken(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^EAA[A-Za-z0-9]{20,}$/.test(value);
}
