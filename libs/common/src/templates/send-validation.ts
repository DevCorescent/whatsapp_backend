import {
  type TemplateSpec,
  dynamicUrlButtonIndexes,
  isAuthentication,
  isCarousel,
  isOtpButton,
  paramCount,
  resolveParameterFormat,
} from './template-spec';

/**
 * What a template still needs before it can be sent.
 *
 * Everything checked here is knowable the moment someone picks a template and fills the
 * form. Without it a campaign was created, queued, handed to Meta and only then refused —
 * one message per recipient, each costing a send attempt — for something we could see in
 * advance. WhatsApp's own words for it are no help either: "Button at index 0 of type Url
 * requires a parameter" does not tell anyone which field on the screen is empty.
 *
 * Deliberately not checked: whether a value is *right*. A wrong coupon code or a link to
 * the wrong page is not something we can know, and refusing to send over a guess would be
 * worse than sending.
 */
export interface SendValues {
  /** One entry per body variable, in order. */
  bodyVarMapping?: string[];
  /** One entry per dynamic URL button, in the order `dynamicUrlButtonIndexes` returns. */
  urlButtonMapping?: string[];
  /** One entry per variable in a TEXT header, in order. */
  headerVarMapping?: string[];
  headerMediaId?: string | null;
  headerMediaUrl?: string | null;
  couponCode?: string | null;
  /** Per-card media the campaign supplies, index-aligned with the template's cards. */
  cardMedia?: ({ id?: string | null; link?: string | null } | null)[] | null;
  /**
   * Per-recipient overrides, keyed by phone. A slot counts as supplied when the mapping
   * carries a default *or* every recipient has their own value — a campaign that fills
   * each person's name individually has no default and is still complete.
   */
  recipientFields?: Record<string, Record<string, string>>;
  /** Phones the campaign will actually send to; the ones `recipientFields` must cover. */
  phones?: string[];
}

function filled(v: unknown): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : v != null;
}

/** True when every recipient supplies this key themselves. */
function coveredPerRecipient(values: SendValues, key: string): boolean {
  const phones = values.phones ?? [];
  if (!phones.length) return false;
  const fields = values.recipientFields ?? {};
  return phones.every((p) => filled(fields[p]?.[key]));
}

/**
 * Human-readable list of what is missing. Empty means the send is complete.
 * Each entry names the field as the person filling the form would recognise it.
 */
export function missingSendValues(spec: TemplateSpec, values: SendValues): string[] {
  const missing: string[] = [];
  const format = resolveParameterFormat(spec);
  const body = values.bodyVarMapping ?? [];

  // Authentication templates carry exactly one value — the code — in the body, and
  // repeat it on the button themselves. Nothing else is asked for.
  if (isAuthentication(spec)) {
    if (!filled(body[0]) && !coveredPerRecipient(values, 'slot_1')) {
      missing.push('the verification code this template sends');
    }
    return missing;
  }

  // ── Body ──
  const bodyNeeded = paramCount(spec.body ?? '', format);
  for (let i = 0; i < bodyNeeded; i++) {
    if (!filled(body[i]) && !coveredPerRecipient(values, `slot_${i + 1}`)) {
      missing.push(`a value for the message's {{${i + 1}}}`);
    }
  }

  // ── Header ──
  const headerFormat = spec.headerType?.toUpperCase();
  if (headerFormat === 'TEXT' && spec.headerContent) {
    const headerNeeded = paramCount(spec.headerContent, format);
    const header = values.headerVarMapping ?? [];
    for (let i = 0; i < headerNeeded; i++) {
      if (!filled(header[i]) && !coveredPerRecipient(values, `header_${i + 1}`)) {
        missing.push(`a value for the heading's {{${i + 1}}}`);
      }
    }
  } else if (headerFormat && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat)) {
    if (!filled(values.headerMediaId) && !filled(values.headerMediaUrl)) {
      missing.push(`the ${headerFormat.toLowerCase()} this template shows at the top`);
    }
  }

  // ── Buttons ──
  // Indexed by position among the dynamic URL buttons, which is the order the form
  // presents them in — not their position among all of the template's buttons.
  const urls = values.urlButtonMapping ?? [];
  dynamicUrlButtonIndexes(spec).forEach((buttonIndex, slot) => {
    if (!filled(urls[slot]) && !coveredPerRecipient(values, `url_${buttonIndex + 1}`)) {
      const label = spec.buttons?.[buttonIndex]?.text?.trim();
      missing.push(`the link for the ${label ? `"${label}" button` : 'button'}`);
    }
  });

  for (const b of spec.buttons ?? []) {
    if (b.type === 'COPY_CODE' && !filled(values.couponCode) && !filled(b.offerCode)) {
      missing.push('the code the "copy code" button gives people');
    }
  }

  // A carousel's cards each carry their own media, and a card with none renders empty.
  // The campaign may supply it per card, so the template's own URL is only the fallback —
  // checking the template alone would refuse every carousel whose media is chosen at send
  // time, which is the normal way to use one.
  if (isCarousel(spec)) {
    (spec.cards ?? []).forEach((card, i) => {
      if (!card.headerFormat) return;
      const supplied = values.cardMedia?.[i];
      if (filled(supplied?.id) || filled(supplied?.link) || filled(card.headerUrl)) return;
      missing.push(`the image for carousel card ${i + 1}`);
    });
  }

  return missing;
}

/** One sentence naming everything missing, for an error the sender can act on. */
export function describeMissing(missing: string[]): string {
  if (missing.length === 1) return `This template still needs ${missing[0]}.`;
  const last = missing[missing.length - 1];
  return `This template still needs ${missing.slice(0, -1).join(', ')} and ${last}.`;
}

export { isOtpButton };
