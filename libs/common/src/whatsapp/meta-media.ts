export const WA_API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v20.0';

export interface MetaMediaInfo {
  url: string;
  mimeType: string;
  size: number | null;
  sha256: string | null;
}

/** Resolves a Meta media id to its short-lived CDN URL (step 1 of the two-step download). */
export async function lookupMetaMedia(mediaId: string, accessToken: string): Promise<MetaMediaInfo> {
  const res = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Meta media lookup ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { url: string; mime_type?: string; file_size?: number; sha256?: string };
  return {
    url:      json.url,
    mimeType: json.mime_type ?? 'application/octet-stream',
    size:     typeof json.file_size === 'number' ? json.file_size : null,
    sha256:   json.sha256 ?? null,
  };
}

/** Downloads the bytes behind a Meta media id. */
export async function downloadMetaMedia(mediaId: string, accessToken: string): Promise<{ buffer: Buffer; info: MetaMediaInfo }> {
  const info = await lookupMetaMedia(mediaId, accessToken);
  const res = await fetch(info.url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Meta media download ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, info: { ...info, size: info.size ?? buffer.byteLength } };
}
