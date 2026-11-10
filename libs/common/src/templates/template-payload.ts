/**
 * Translation between a stored template and Meta's wire format.
 *
 * Three directions, all in one place so they cannot drift apart:
 *   buildCreatePayload — our row  → POST /{waba-id}/message_templates
 *   buildSendComponents — our row → the `template.components` of an outgoing message
 *   parseMetaTemplate  — Meta's row → ours, for importing what already exists in the WABA
 *
 * The create payload carries the `example` objects Meta requires whenever a component
 * holds a variable. Without them every template with a placeholder is rejected, which is
 * why they are built here rather than at each call site.
 */

import {
  BUTTON_MAX,
  CAROUSEL_BUTTON_TYPES,
  LIMITS,
  type ParameterFormat,
  type TemplateButtonSpec,
  type TemplateCardSpec,
  type TemplateSpec,
  hasLimitedTimeOffer,
  isAuthentication,
  isCarousel,
  isOtpButton,
  namedParams,
  paramCount,
  positionalCount,
  resolveParameterFormat,
} from './template-spec';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Trimmed non-empty string, or undefined. */
const str = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length ? s : undefined;
};

/**
 * Example values for a string's variables, in Meta's two shapes.
 * `key` is the field prefix: `body_text` / `header_text`.
 */
function textExample(
  text: string,
  examples: string[],
  format: ParameterFormat,
  key: 'body_text' | 'header_text',
): Record<string, unknown> | undefined {
  if (format === 'NAMED') {
    const names = namedParams(text);
    if (!names.length) return undefined;
    return {
      [`${key}_named_params`]: names.map((param_name, i) => ({
        param_name,
        example: examples[i] ?? '',
      })),
    };
  }
  const count = positionalCount(text);
  if (!count) return undefined;
  const values = Array.from({ length: count }, (_, i) => examples[i] ?? '');
  // Header examples are a flat array; body examples are an array of one row.
  return key === 'header_text' ? { header_text: values } : { body_text: [values] };
}

function buttonPayload(b: TemplateButtonSpec): Record<string, unknown> | null {
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: str(b.text) };

    case 'URL': {
      const url = str(b.url);
      if (!url) return null;
      const payload: Record<string, unknown> = { type: 'URL', text: str(b.text), url };
      // A URL button may end in one variable; Meta wants the sample value for it.
      if (/\{\{.+?\}\}/.test(url)) payload.example = [str(b.urlExample) ?? ''];
      return payload;
    }

    case 'PHONE_NUMBER': {
      const phone = str(b.phone);
      if (!phone) return null;
      return { type: 'PHONE_NUMBER', text: str(b.text), phone_number: phone };
    }

    case 'VOICE_CALL':
      return { type: 'VOICE_CALL', text: str(b.text) };

    case 'COPY_CODE': {
      const code = str(b.offerCode);
      if (!code) return null;
      return { type: 'COPY_CODE', example: code };
    }

    case 'OTP': {
      const otpType = b.otpType ?? 'COPY_CODE';
      const payload: Record<string, unknown> = { type: 'OTP', otp_type: otpType };
      if (otpType === 'COPY_CODE') {
        // Meta writes the label itself, but honours one if given.
        if (str(b.text)) payload.text = str(b.text);
        return payload;
      }
      // One-tap and zero-tap autofill from the business's own app, so they need it named.
      const pkg = str(b.packageName);
      const hash = str(b.signatureHash);
      if (pkg && hash) payload.supported_apps = [{ package_name: pkg, signature_hash: hash }];
      if (str(b.autofillText)) payload.autofill_text = str(b.autofillText);
      if (str(b.text)) payload.text = str(b.text);
      if (otpType === 'ZERO_TAP') payload.zero_tap_terms_accepted = b.zeroTapTermsAccepted ?? true;
      return payload;
    }

    case 'FLOW': {
      const payload: Record<string, unknown> = { type: 'FLOW', text: str(b.text) };
      if (str(b.flowId)) payload.flow_id = str(b.flowId);
      payload.flow_action = b.flowAction ?? 'navigate';
      if (str(b.navigateScreen)) payload.navigate_screen = str(b.navigateScreen);
      return payload;
    }

    case 'CATALOG':
      return { type: 'CATALOG', text: str(b.text) };

    case 'MPM':
      return { type: 'MPM', text: str(b.text) };

    default:
      return null;
  }
}

function cardPayload(card: TemplateCardSpec, format: ParameterFormat): Record<string, unknown> {
  const components: Record<string, unknown>[] = [
    {
      type: 'HEADER',
      format: card.headerFormat,
      example: { header_handle: [str(card.headerHandle) ?? ''] },
    },
  ];

  const body = str(card.body);
  if (body) {
    const component: Record<string, unknown> = { type: 'BODY', text: body };
    const example = textExample(body, card.bodyVariables ?? [], format, 'body_text');
    if (example) component.example = example;
    components.push(component);
  }

  const buttons = (card.buttons ?? []).map(buttonPayload).filter(Boolean);
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });

  return { components };
}

// ─── Create ───────────────────────────────────────────────────────────────────

/** The body of `POST /{waba-id}/message_templates`. */
export function buildCreatePayload(spec: TemplateSpec): Record<string, unknown> {
  const format = resolveParameterFormat(spec);
  const components: Record<string, unknown>[] = [];

  if (isAuthentication(spec)) {
    // Meta writes the copy for authentication templates. We only choose the options.
    const body: Record<string, unknown> = { type: 'BODY' };
    if (spec.addSecurityRecommendation) body.add_security_recommendation = true;
    components.push(body);

    if (spec.codeExpirationMinutes) {
      components.push({ type: 'FOOTER', code_expiration_minutes: spec.codeExpirationMinutes });
    }

    const otp = (spec.buttons ?? []).find((b) => b.type === 'OTP') ?? { type: 'OTP' as const };
    const otpPayload = buttonPayload(otp);
    if (otpPayload) components.push({ type: 'BUTTONS', buttons: [otpPayload] });

    return {
      name: spec.name,
      language: spec.language,
      category: 'AUTHENTICATION',
      ...(spec.messageSendTtlSeconds ? { message_send_ttl_seconds: spec.messageSendTtlSeconds } : {}),
      components,
    };
  }

  // ── Header ──
  const headerFormat = spec.headerType?.toUpperCase();
  if (headerFormat && headerFormat !== 'NONE' && !isCarousel(spec)) {
    if (headerFormat === 'TEXT') {
      const text = str(spec.headerContent);
      if (text) {
        const header: Record<string, unknown> = { type: 'HEADER', format: 'TEXT', text };
        const example = textExample(text, spec.headerVariables ?? [], format, 'header_text');
        if (example) header.example = example;
        components.push(header);
      }
    } else if (headerFormat === 'LOCATION') {
      // The pin itself is supplied per message, so there is nothing to example here.
      components.push({ type: 'HEADER', format: 'LOCATION' });
    } else {
      components.push({
        type: 'HEADER',
        format: headerFormat,
        example: { header_handle: [str(spec.headerContent) ?? ''] },
      });
    }
  }

  // ── Body ──
  const bodyComponent: Record<string, unknown> = { type: 'BODY', text: spec.body };
  const bodyExample = textExample(spec.body, spec.variables ?? [], format, 'body_text');
  if (bodyExample) bodyComponent.example = bodyExample;
  components.push(bodyComponent);

  // ── Footer ──
  const footer = str(spec.footer);
  if (footer && !isCarousel(spec)) components.push({ type: 'FOOTER', text: footer });

  // ── Limited-time offer ──
  if (hasLimitedTimeOffer(spec)) {
    components.push({
      type: 'LIMITED_TIME_OFFER',
      limited_time_offer: {
        text: str(spec.ltoText),
        has_expiration: Boolean(spec.ltoHasExpiration),
      },
    });
  }

  // ── Buttons ──
  const buttons = (spec.buttons ?? []).map(buttonPayload).filter(Boolean);
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });

  // ── Carousel ──
  if (isCarousel(spec)) {
    components.push({
      type: 'CAROUSEL',
      cards: (spec.cards ?? []).map((c) => cardPayload(c, format)),
    });
  }

  return {
    name: spec.name,
    language: spec.language,
    category: spec.category.toUpperCase(),
    parameter_format: format,
    ...(spec.messageSendTtlSeconds ? { message_send_ttl_seconds: spec.messageSendTtlSeconds } : {}),
    components,
  };
}

// ─── Send ─────────────────────────────────────────────────────────────────────

export interface SendContext {
  /** Values keyed by parameter name and/or by position ("1", "2", "header_1", "button_1"). */
  variables?: Record<string, string>;
  /** Media for a media header: an uploaded WhatsApp media id, or a public link. */
  headerMediaId?: string | null;
  headerMediaUrl?: string | null;
  /** Per-card media, index-aligned with the template's cards. Falls back to the card's own URL. */
  cardMedia?: ({ id?: string | null; link?: string | null } | null)[] | null;
  /** When the offer expires, unix milliseconds. Required by a template with a countdown. */
  offerExpirationMs?: number | null;
  /** The code a copy-code button should carry. Defaults to the template's sample. */
  couponCode?: string | null;
  location?: { latitude: string; longitude: string; name?: string; address?: string } | null;
}

/** One `{type:'text'}` parameter, named or positional. */
function textParam(format: ParameterFormat, name: string, value: string): Record<string, unknown> {
  return format === 'NAMED'
    ? { type: 'text', parameter_name: name, text: value }
    : { type: 'text', text: value };
}

/** Values for one string's variables, read out of the send context. */
function paramsFor(
  text: string,
  format: ParameterFormat,
  vars: Record<string, string>,
  positionalPrefix = '',
): Record<string, unknown>[] {
  if (format === 'NAMED') {
    return namedParams(text).map((name) => textParam(format, name, vars[name] ?? ''));
  }
  const count = positionalCount(text);
  return Array.from({ length: count }, (_, i) => {
    const key = `${positionalPrefix}${i + 1}`;
    return textParam(format, key, vars[key] ?? vars[String(i + 1)] ?? '');
  });
}

function mediaParam(
  format: string,
  media: { id?: string | null; link?: string | null },
): Record<string, unknown> | null {
  const kind = format.toLowerCase();
  if (media.id) return { type: kind, [kind]: { id: media.id } };
  if (media.link) return { type: kind, [kind]: { link: media.link } };
  return null;
}

/** The `components` array of an outgoing template message. */
export function buildSendComponents(spec: TemplateSpec, ctx: SendContext = {}): Record<string, unknown>[] {
  const format = resolveParameterFormat(spec);
  const vars = ctx.variables ?? {};
  const components: Record<string, unknown>[] = [];

  // Authentication templates carry the code in the body and repeat it on the button.
  if (isAuthentication(spec)) {
    const code = str(vars['1']) ?? str(vars.code) ?? '';
    components.push({ type: 'body', parameters: [{ type: 'text', text: code }] });
    // Matched by shape, not by type alone: Meta returns this button typed URL, and
    // looking only for 'OTP' meant every authentication template imported from Meta went
    // out with no value for its button and was refused.
    const otp = (spec.buttons ?? []).find(isOtpButton);
    if (otp && otp.otpType !== 'ZERO_TAP') {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: 0,
        parameters: [{ type: 'text', text: code }],
      });
    }
    return components;
  }

  // ── Header ──
  const headerFormat = spec.headerType?.toUpperCase();
  if (headerFormat === 'TEXT' && spec.headerContent) {
    const params = paramsFor(spec.headerContent, format, vars, 'header_');
    if (params.length) components.push({ type: 'header', parameters: params });
  } else if (headerFormat === 'LOCATION' && ctx.location) {
    components.push({ type: 'header', parameters: [{ type: 'location', location: ctx.location }] });
  } else if (headerFormat && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat)) {
    const param = mediaParam(headerFormat, { id: ctx.headerMediaId, link: ctx.headerMediaUrl });
    if (param) components.push({ type: 'header', parameters: [param] });
  }

  // ── Body ──
  const bodyParams = paramsFor(spec.body, format, vars);
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });

  // ── Limited-time offer ──
  if (hasLimitedTimeOffer(spec) && ctx.offerExpirationMs) {
    components.push({
      type: 'limited_time_offer',
      parameters: [{
        type: 'limited_time_offer',
        limited_time_offer: { expiration_time_ms: ctx.offerExpirationMs },
      }],
    });
  }

  // ── Buttons that take a value at send time ──
  (spec.buttons ?? []).forEach((b, index) => {
    // An OTP button is never filled in here — authentication templates return above, and
    // outside them this button has no meaning.
    if (b.type === 'URL' && b.url && /\{\{.+?\}\}/.test(b.url) && !isOtpButton(b)) {
      const value = vars[`button_${index + 1}`] ?? vars[`url_${index + 1}`] ?? '';
      components.push({
        type: 'button', sub_type: 'url', index,
        parameters: [{ type: 'text', text: value }],
      });
    }
    if (b.type === 'COPY_CODE') {
      const code = str(ctx.couponCode) ?? str(b.offerCode) ?? '';
      if (code) {
        components.push({
          type: 'button', sub_type: 'copy_code', index,
          parameters: [{ type: 'coupon_code', coupon_code: code }],
        });
      }
    }
  });

  // ── Carousel ──
  if (isCarousel(spec)) {
    const cards = (spec.cards ?? []).map((card, cardIndex) => {
      const cardComponents: Record<string, unknown>[] = [];

      const override = ctx.cardMedia?.[cardIndex] ?? null;
      const param = mediaParam(card.headerFormat, {
        id: override?.id,
        link: override?.link ?? card.headerUrl,
      });
      if (param) cardComponents.push({ type: 'header', parameters: [param] });

      if (card.body) {
        const params = paramsFor(card.body, format, vars, `card_${cardIndex}_`);
        if (params.length) cardComponents.push({ type: 'body', parameters: params });
      }

      (card.buttons ?? []).forEach((b, index) => {
        if (b.type === 'URL' && b.url && /\{\{.+?\}\}/.test(b.url)) {
          const value = vars[`card_${cardIndex}_button_${index + 1}`] ?? '';
          cardComponents.push({
            type: 'button', sub_type: 'url', index,
            parameters: [{ type: 'text', text: value }],
          });
        }
      });

      return { card_index: cardIndex, components: cardComponents };
    });

    components.push({ type: 'carousel', cards });
  }

  return components;
}

// ─── Parse (import from Meta) ─────────────────────────────────────────────────

interface MetaComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Record<string, unknown>[];
  cards?: { components?: MetaComponent[] }[];
  example?: Record<string, unknown>;
  limited_time_offer?: { text?: string; has_expiration?: boolean };
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
}

function parseButton(b: Record<string, any>): TemplateButtonSpec {
  const type = String(b.type ?? '').toUpperCase() as TemplateButtonSpec['type'];
  const out: TemplateButtonSpec = { type, text: b.text ?? null };
  if (type === 'URL') {
    out.url = b.url ?? null;
    out.urlExample = Array.isArray(b.example) ? String(b.example[0] ?? '') : null;
  }
  if (type === 'PHONE_NUMBER' || type === 'VOICE_CALL') out.phone = b.phone_number ?? null;
  if (type === 'COPY_CODE') out.offerCode = typeof b.example === 'string' ? b.example : null;
  if (type === 'OTP') {
    out.otpType = (b.otp_type ?? 'COPY_CODE') as TemplateButtonSpec['otpType'];
    out.autofillText = b.autofill_text ?? null;
    const app = Array.isArray(b.supported_apps) ? b.supported_apps[0] : null;
    out.packageName = app?.package_name ?? null;
    out.signatureHash = app?.signature_hash ?? null;
    out.zeroTapTermsAccepted = b.zero_tap_terms_accepted ?? null;
  }
  if (type === 'FLOW') {
    out.flowId = b.flow_id != null ? String(b.flow_id) : null;
    out.flowAction = b.flow_action ?? null;
    out.navigateScreen = b.navigate_screen ?? null;
  }
  return out;
}

/** Example values out of a component's `example`, in whichever shape Meta used. */
function parseExamples(example: Record<string, any> | undefined, key: 'body_text' | 'header_text'): string[] {
  if (!example) return [];
  const named = example[`${key}_named_params`];
  if (Array.isArray(named)) return named.map((p: any) => String(p?.example ?? ''));
  const positional = example[key];
  if (Array.isArray(positional)) {
    // body_text is [[...]]; header_text is [...].
    const first = positional[0];
    return Array.isArray(first) ? first.map(String) : positional.map(String);
  }
  return [];
}

/** A template as Meta returns it, flattened into the shape we store. */
export function parseMetaTemplate(remote: Record<string, any>): Partial<TemplateSpec> & { body: string } {
  const components: MetaComponent[] = Array.isArray(remote.components) ? remote.components : [];
  const find = (t: string) => components.find((c) => String(c.type ?? '').toUpperCase() === t);

  const header = find('HEADER');
  const body = find('BODY');
  const footer = find('FOOTER');
  const buttons = find('BUTTONS');
  const carousel = find('CAROUSEL');
  const lto = find('LIMITED_TIME_OFFER');

  const headerFormat = header?.format?.toUpperCase() ?? null;

  const cards: TemplateCardSpec[] = (carousel?.cards ?? []).map((card) => {
    const cardComponents = card.components ?? [];
    const cardHeader = cardComponents.find((c) => String(c.type ?? '').toUpperCase() === 'HEADER');
    const cardBody = cardComponents.find((c) => String(c.type ?? '').toUpperCase() === 'BODY');
    const cardButtons = cardComponents.find((c) => String(c.type ?? '').toUpperCase() === 'BUTTONS');
    const handle = (cardHeader?.example as any)?.header_handle?.[0] ?? null;
    return {
      headerFormat: (cardHeader?.format?.toUpperCase() === 'VIDEO' ? 'VIDEO' : 'IMAGE'),
      headerHandle: typeof handle === 'string' ? handle : null,
      headerUrl: null,
      body: cardBody?.text ?? null,
      bodyVariables: parseExamples(cardBody?.example as any, 'body_text'),
      buttons: (cardButtons?.buttons ?? []).map(parseButton),
    };
  });

  return {
    name: remote.name,
    category: remote.category,
    language: remote.language,
    templateType: cards.length ? 'CAROUSEL' : 'STANDARD',
    parameterFormat: String(remote.parameter_format ?? '').toUpperCase() === 'NAMED' ? 'NAMED' : 'POSITIONAL',
    headerType: headerFormat,
    headerContent: headerFormat === 'TEXT'
      ? (header?.text ?? null)
      : ((header?.example as any)?.header_handle?.[0] ?? null),
    headerVariables: parseExamples(header?.example as any, 'header_text'),
    body: body?.text ?? '',
    variables: parseExamples(body?.example as any, 'body_text'),
    footer: footer?.text ?? null,
    buttons: (buttons?.buttons ?? []).map(parseButton),
    cards: cards.length ? cards : null,
    ltoText: lto?.limited_time_offer?.text ?? null,
    ltoHasExpiration: lto?.limited_time_offer?.has_expiration ?? false,
    addSecurityRecommendation: body?.add_security_recommendation ?? false,
    codeExpirationMinutes: footer?.code_expiration_minutes ?? null,
    messageSendTtlSeconds: remote.message_send_ttl_seconds ?? null,
  };
}

// ─── Validate ─────────────────────────────────────────────────────────────────

/**
 * Everything Meta would reject, checked before we spend a submission on it.
 * Returns one message per problem; empty means the draft is submittable.
 */
export function validateTemplate(spec: TemplateSpec): string[] {
  const errors: string[] = [];
  const format = resolveParameterFormat(spec);

  if (!spec.name?.trim()) errors.push('Template name is required.');
  else if (!/^[a-z0-9_]+$/.test(spec.name)) errors.push('Template name may use only lowercase letters, numbers and underscores.');
  else if (spec.name.length > LIMITS.nameChars) errors.push(`Template name is over ${LIMITS.nameChars} characters.`);

  if (isAuthentication(spec)) {
    const otp = (spec.buttons ?? []).find((b) => b.type === 'OTP');
    const minutes = spec.codeExpirationMinutes;
    if (minutes != null && (minutes < LIMITS.codeExpirationMin || minutes > LIMITS.codeExpirationMax)) {
      errors.push(`Code expiry must be between ${LIMITS.codeExpirationMin} and ${LIMITS.codeExpirationMax} minutes.`);
    }
    if (otp && otp.otpType !== 'COPY_CODE' && (!otp.packageName?.trim() || !otp.signatureHash?.trim())) {
      errors.push('One-tap and zero-tap buttons need your app package name and signature hash.');
    }
    if ((spec.buttons ?? []).some((b) => b.type !== 'OTP')) {
      errors.push('An authentication template may carry only its one-time-password button.');
    }
    return errors;
  }

  // ── Body ──
  if (!spec.body?.trim()) errors.push('Message body is required.');
  else if (spec.body.length > LIMITS.bodyChars) errors.push(`Body is ${spec.body.length} characters — the limit is ${LIMITS.bodyChars}.`);
  // Meta refuses a body that opens or closes on a placeholder (error 2388299).
  if (/^\s*\{\{/.test(spec.body ?? '')) errors.push('A body cannot open with a variable. Put at least one character before it.');
  if (/\}\}\s*$/.test(spec.body ?? '')) errors.push('A body cannot end with a variable. Put at least one character after it.');

  const bodyVars = paramCount(spec.body ?? '', format);
  const bodyExamples = (spec.variables ?? []).filter((v) => v?.trim()).length;
  if (bodyVars > bodyExamples) {
    errors.push(`Give an example for each of the body's ${bodyVars} variables — ${bodyExamples} filled in.`);
  }
  if (format === 'POSITIONAL' && spec.body) {
    const used = [...new Set([...spec.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    if (used.length && (used[0] !== 1 || used.some((n, i) => n !== i + 1))) {
      errors.push('Numbered variables must run 1, 2, 3 with nothing skipped.');
    }
  }

  // ── Header ──
  const headerFormat = spec.headerType?.toUpperCase();
  if (headerFormat === 'TEXT') {
    const text = spec.headerContent ?? '';
    if (text.length > LIMITS.headerTextChars) errors.push(`Header is ${text.length} characters — the limit is ${LIMITS.headerTextChars}.`);
    const vars = paramCount(text, format);
    if (vars > LIMITS.headerTextParams) errors.push('A header may hold only one variable.');
    if (vars > (spec.headerVariables ?? []).filter((v) => v?.trim()).length) errors.push("Give an example for the header's variable.");
  } else if (headerFormat && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat) && !spec.headerContent?.trim()) {
    errors.push(`Upload the ${headerFormat.toLowerCase()} for the header.`);
  }
  if (headerFormat === 'LOCATION' && !['MARKETING', 'UTILITY'].includes(spec.category?.toUpperCase())) {
    errors.push('A location header is available only on marketing and utility templates.');
  }

  // ── Footer ──
  if ((spec.footer?.length ?? 0) > LIMITS.footerChars) {
    errors.push(`Footer is ${spec.footer!.length} characters — the limit is ${LIMITS.footerChars}.`);
  }

  // ── Buttons ──
  const buttons = spec.buttons ?? [];
  if (buttons.length > LIMITS.buttonsTotal) errors.push(`A template may carry ${LIMITS.buttonsTotal} buttons at most.`);
  const counts: Record<string, number> = {};
  for (const b of buttons) counts[b.type] = (counts[b.type] ?? 0) + 1;
  for (const [type, used] of Object.entries(counts)) {
    const allowed = (BUTTON_MAX as Record<string, number>)[type] ?? 1;
    if (used > allowed) errors.push(`Only ${allowed} ${type.replace('_', ' ').toLowerCase()} button${allowed > 1 ? 's' : ''} allowed.`);
  }
  buttons.forEach((b, i) => {
    const label = `Button ${i + 1}`;
    if (b.type !== 'COPY_CODE' && b.type !== 'OTP' && !b.text?.trim()) errors.push(`${label} needs a label.`);
    if ((b.text?.length ?? 0) > LIMITS.buttonTextChars) errors.push(`${label}'s label is over ${LIMITS.buttonTextChars} characters.`);
    if (b.type === 'URL') {
      if (!b.url?.trim()) errors.push(`${label} needs a URL.`);
      else if (!/^https:\/\//i.test(b.url.trim())) errors.push(`${label}'s URL must start with https://.`);
      else if (b.url.length > LIMITS.urlChars) errors.push(`${label}'s URL is over ${LIMITS.urlChars} characters.`);
      if (/\{\{.+?\}\}/.test(b.url ?? '') && !b.urlExample?.trim()) errors.push(`${label} needs an example for its URL variable.`);
    }
    if ((b.type === 'PHONE_NUMBER' || b.type === 'VOICE_CALL') && !b.phone?.trim()) {
      errors.push(`${label} needs a phone number.`);
    }
    if (b.type === 'COPY_CODE') {
      if (!b.offerCode?.trim()) errors.push(`${label} needs an example code.`);
      else if (b.offerCode.length > LIMITS.copyCodeChars) errors.push(`${label}'s code is over ${LIMITS.copyCodeChars} characters.`);
    }
    if (b.type === 'OTP') errors.push('One-time-password buttons belong on authentication templates.');
  });

  // Quick replies and call-to-action buttons cannot be mixed.
  const hasQuickReply = buttons.some((b) => b.type === 'QUICK_REPLY');
  const hasCta = buttons.some((b) => ['URL', 'PHONE_NUMBER', 'VOICE_CALL', 'COPY_CODE'].includes(b.type));
  if (hasQuickReply && hasCta) errors.push('Quick replies cannot sit alongside website, call or copy-code buttons.');

  // ── Limited-time offer ──
  if (hasLimitedTimeOffer(spec)) {
    if (spec.category?.toUpperCase() !== 'MARKETING') errors.push('A limited-time offer is available only on marketing templates.');
    if ((spec.ltoText?.length ?? 0) > LIMITS.ltoTextChars) errors.push(`Offer text is over ${LIMITS.ltoTextChars} characters.`);
    if (!buttons.some((b) => b.type === 'COPY_CODE')) errors.push('A limited-time offer needs a copy-code button.');
    if (!buttons.some((b) => b.type === 'URL')) errors.push('A limited-time offer needs a website button.');
  }

  // ── Carousel ──
  if (isCarousel(spec)) {
    const cards = spec.cards ?? [];
    if (cards.length < LIMITS.carouselCardsMin || cards.length > LIMITS.carouselCardsMax) {
      errors.push(`A carousel needs between ${LIMITS.carouselCardsMin} and ${LIMITS.carouselCardsMax} cards — it has ${cards.length}.`);
    }
    if (spec.headerType && spec.headerType !== 'NONE') errors.push('A carousel template has no header of its own; each card carries its own media.');
    if (spec.footer?.trim()) errors.push('A carousel template has no footer.');

    // Meta requires every card to be built the same way.
    const shape = (c: TemplateCardSpec) =>
      [c.headerFormat, c.body?.trim() ? 'body' : '-', (c.buttons ?? []).map((b) => b.type).join('+')].join('|');
    const shapes = new Set(cards.map(shape));
    if (shapes.size > 1) errors.push('Every card must be built the same way — same media type, same buttons, body on all or none.');

    cards.forEach((c, i) => {
      const label = `Card ${i + 1}`;
      if (!c.headerHandle?.trim()) errors.push(`${label} needs its ${c.headerFormat.toLowerCase()} uploaded.`);
      if (!c.headerUrl?.trim()) errors.push(`${label} needs a public media URL so the card can be sent.`);
      if ((c.body?.length ?? 0) > LIMITS.carouselBodyChars) errors.push(`${label}'s text is over ${LIMITS.carouselBodyChars} characters.`);
      if ((c.buttons ?? []).length > LIMITS.carouselButtons) errors.push(`${label} may carry ${LIMITS.carouselButtons} buttons at most.`);
      (c.buttons ?? []).forEach((b) => {
        if (!(CAROUSEL_BUTTON_TYPES as readonly string[]).includes(b.type)) {
          errors.push(`${label} cannot use a ${b.type.replace('_', ' ').toLowerCase()} button.`);
        }
      });
      const cardVars = paramCount(c.body ?? '', format);
      if (cardVars > (c.bodyVariables ?? []).filter((v) => v?.trim()).length) {
        errors.push(`${label} needs an example for each of its variables.`);
      }
    });
  }

  return errors;
}
