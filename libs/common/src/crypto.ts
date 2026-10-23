import { createDecipheriv, createHash } from 'node:crypto';

const ENVELOPE_PREFIX = 'enc:v1:';
const ALGORITHM       = 'aes-256-gcm';

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
