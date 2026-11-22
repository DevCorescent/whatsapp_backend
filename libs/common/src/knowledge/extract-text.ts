import { Logger } from '@nestjs/common';

const logger = new Logger('ExtractText');

/**
 * What a file actually says, as plain text.
 *
 * The knowledge base stores one `content` column and every reader — the auto-reply's
 * search, FAQ generation, the agent-facing answer button — works from it. Nothing was
 * ever writing it for an uploaded file: `POST /knowledge` had no multipart handler at
 * all, so the bytes were parsed as JSON, discarded, and the row was created with
 * `content = NULL`. The documents in the live database show it — four PDFs marked
 * indexed with no text in them.
 *
 * Images are not handled here. The upload dialog used to promise OCR for scanned files
 * and nothing in the codebase has ever done it, so they are refused with that said
 * plainly rather than accepted into a row that cannot answer anything.
 */

export interface ExtractedText {
  /** The document's text, already trimmed. Empty when nothing could be read. */
  text: string;
  /** Why there is no text, in a sentence the uploader can act on. */
  problem: string | null;
}

const MAX_CHARS = 200_000;

function ok(text: string): ExtractedText {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean
    ? { text: clean.slice(0, MAX_CHARS), problem: null }
    : { text: '', problem: 'No readable text found in this file.' };
}

/** The document kind we record, from the filename and the browser's content type. */
export function docTypeOf(filename: string, mimetype?: string): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf' || mimetype === 'application/pdf') return 'PDF';
  if (ext === 'docx' || mimetype?.includes('wordprocessingml')) return 'DOCX';
  if (ext === 'md') return 'MD';
  if (ext === 'csv') return 'CSV';
  if (['png', 'jpg', 'jpeg', 'webp', 'tiff', 'bmp', 'gif'].includes(ext)) return 'IMAGE';
  return 'TXT';
}

export async function extractFileText(
  buffer: Buffer,
  filename: string,
  mimetype?: string,
): Promise<ExtractedText> {
  const type = docTypeOf(filename, mimetype);

  if (type === 'IMAGE') {
    return { text: '', problem: 'Images can’t be read yet — upload a PDF, DOCX or text file.' };
  }

  try {
    if (type === 'PDF') {
      // v2 of pdf-parse is a class; the v1 default-export function is gone.
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        // `result.text` interleaves a "-- 3 of 12 --" marker between pages. Joining the
        // page texts gives the same words without page furniture the model would quote.
        const joined = (result.pages ?? []).map((p) => p.text ?? '').join('\n\n');
        const out = ok(joined || result.text || '');
        return out.text
          ? out
          : { text: '', problem: 'This PDF has no selectable text — it looks scanned.' };
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }

    if (type === 'DOCX') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return ok(result.value ?? '');
    }

    return ok(buffer.toString('utf8'));
  } catch (err: any) {
    logger.warn(`extract ${type} "${filename}" failed: ${err?.message ?? err}`);
    return { text: '', problem: `This file could not be read (${err?.message ?? 'unknown error'}).` };
  }
}

/**
 * The readable text of a web page.
 *
 * Script and style blocks go first — otherwise a page's JavaScript ends up in the
 * knowledge base and the model quotes it back at customers.
 */
export async function extractUrlText(url: string): Promise<ExtractedText> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'WaboxaKnowledgeBot/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return { text: '', problem: `That page answered ${res.status}.` };
    }

    const html = await res.text();
    const text = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]{2,}/g, ' ');

    return ok(text);
  } catch (err: any) {
    const reason = err?.name === 'TimeoutError' ? 'it took too long to respond' : (err?.message ?? 'unknown error');
    return { text: '', problem: `That page could not be fetched (${reason}).` };
  }
}
