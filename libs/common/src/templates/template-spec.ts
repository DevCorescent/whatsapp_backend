/**
 * What Meta accepts in a message template, in one place.
 *
 * Every limit here comes from the Cloud API template docs. They are the same numbers the
 * template builder enforces in the browser; keeping them next to the payload builder means
 * a draft that passes validation here is a draft Meta will accept.
 */

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
export type ParameterFormat = 'POSITIONAL' | 'NAMED';
export type TemplateType = 'STANDARD' | 'CAROUSEL';

/** Header formats. GIF is Marketing Messages API only, so it is deliberately absent. */
export type HeaderFormat = 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
export const HEADER_FORMATS: readonly HeaderFormat[] = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'];
export const MEDIA_HEADER_FORMATS: readonly HeaderFormat[] = ['IMAGE', 'VIDEO', 'DOCUMENT'];

export type ButtonType =
  | 'QUICK_REPLY'
  | 'URL'
  | 'PHONE_NUMBER'
  | 'COPY_CODE'
  | 'VOICE_CALL'
  | 'OTP'
  | 'FLOW'
  | 'CATALOG'
  | 'MPM';

export type OtpType = 'COPY_CODE' | 'ONE_TAP' | 'ZERO_TAP';

export const LIMITS = {
  nameChars:        512,
  headerTextChars:   60,
  headerTextParams:   1,
  bodyChars:       1024,
  footerChars:       60,
  buttonTextChars:   25,
  /** A copy-code button's code, and an LTO offer code. */
  copyCodeChars:     15,
  urlChars:        2000,
  buttonsTotal:      10,
  ltoTextChars:      16,
  carouselCardsMin:   2,
  carouselCardsMax:  10,
  carouselBodyChars: 160,
  carouselButtons:    2,
  /** Minutes until an authentication code expires. */
  codeExpirationMin:  1,
  codeExpirationMax: 90,
} as const;

/** How many of each button type one template may carry. */
export const BUTTON_MAX: Record<ButtonType, number> = {
  QUICK_REPLY: 10,
  URL:          2,
  PHONE_NUMBER: 1,
  COPY_CODE:    1,
  VOICE_CALL:   1,
  OTP:          1,
  FLOW:         1,
  CATALOG:      1,
  MPM:          1,
};

/** Button types a carousel card may carry. */
export const CAROUSEL_BUTTON_TYPES: readonly ButtonType[] = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'];

export interface TemplateButtonSpec {
  type: ButtonType;
  /** Label. Meta supplies the label for COPY_CODE and OTP buttons. */
  text?: string | null;
  /** URL buttons. May end in one variable, e.g. https://x.com/{{1}}. */
  url?: string | null;
  urlExample?: string | null;
  /** PHONE_NUMBER and VOICE_CALL. */
  phone?: string | null;
  /** COPY_CODE: the sample code shown to the reviewer. */
  offerCode?: string | null;
  /** OTP buttons (authentication templates only). */
  otpType?: OtpType | null;
  autofillText?: string | null;
  packageName?: string | null;
  signatureHash?: string | null;
  zeroTapTermsAccepted?: boolean | null;
  /** FLOW buttons. */
  flowId?: string | null;
  flowAction?: 'navigate' | 'data_exchange' | null;
  navigateScreen?: string | null;
}

export interface TemplateCardSpec {
  /** A card header is required and must be image or video. */
  headerFormat: 'IMAGE' | 'VIDEO';
  /** Resumable-upload handle, used when the template is created. */
  headerHandle?: string | null;
  /** Public URL for the same asset, used when a message is sent. */
  headerUrl?: string | null;
  body?: string | null;
  /** Example values for the card body's variables. */
  bodyVariables?: string[];
  buttons?: TemplateButtonSpec[];
}

/** The stored shape of a template — a `MessageTemplate` row, loosely typed. */
export interface TemplateSpec {
  name: string;
  category: string;
  language: string;
  templateType?: string | null;
  parameterFormat?: string | null;
  headerType?: string | null;
  headerContent?: string | null;
  headerVariables?: string[] | null;
  body: string;
  variables?: string[] | null;
  footer?: string | null;
  buttons?: TemplateButtonSpec[] | null;
  cards?: TemplateCardSpec[] | null;
  ltoText?: string | null;
  ltoHasExpiration?: boolean | null;
  addSecurityRecommendation?: boolean | null;
  codeExpirationMinutes?: number | null;
  messageSendTtlSeconds?: number | null;
}

// ─── Variable parsing ─────────────────────────────────────────────────────────

const NAMED_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const POSITIONAL_RE = /\{\{\s*(\d+)\s*\}\}/g;

/** Named parameters in order of first appearance. */
export function namedParams(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(NAMED_RE)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/** Highest `{{n}}` in the text, which is how many positional values a send must supply. */
export function positionalCount(text: string): number {
  const nums = [...text.matchAll(POSITIONAL_RE)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/** How many variables a string carries, under the given format. */
export function paramCount(text: string, format: ParameterFormat): number {
  return format === 'NAMED' ? namedParams(text).length : positionalCount(text);
}

export function resolveParameterFormat(spec: TemplateSpec): ParameterFormat {
  if (spec.parameterFormat === 'NAMED') return 'NAMED';
  if (spec.parameterFormat === 'POSITIONAL') return 'POSITIONAL';
  // Older rows carry no format: infer it, preferring positional as Meta does.
  const text = `${spec.headerContent ?? ''} ${spec.body ?? ''}`;
  if (positionalCount(text) > 0) return 'POSITIONAL';
  return namedParams(text).length > 0 ? 'NAMED' : 'POSITIONAL';
}

/**
 * A `MessageTemplate` row as a spec. The Json columns come back as `JsonValue`, so the
 * casts live here rather than at every call site.
 */
export function toSpec(row: Record<string, any>): TemplateSpec {
  return {
    name:            row.name,
    category:        row.category,
    language:        row.language,
    templateType:    row.templateType ?? 'STANDARD',
    parameterFormat: row.parameterFormat ?? null,
    headerType:      row.headerType ?? null,
    headerContent:   row.headerContent ?? null,
    headerVariables: Array.isArray(row.headerVariables) ? row.headerVariables : [],
    body:            row.body ?? '',
    variables:       Array.isArray(row.variables) ? row.variables : [],
    footer:          row.footer ?? null,
    buttons:         Array.isArray(row.buttons) ? row.buttons : [],
    cards:           Array.isArray(row.cards) ? row.cards : null,
    ltoText:         row.ltoText ?? null,
    ltoHasExpiration: Boolean(row.ltoHasExpiration),
    addSecurityRecommendation: Boolean(row.addSecurityRecommendation),
    codeExpirationMinutes:     row.codeExpirationMinutes ?? null,
    messageSendTtlSeconds:     row.messageSendTtlSeconds ?? null,
  };
}

export function isCarousel(spec: TemplateSpec): boolean {
  return spec.templateType === 'CAROUSEL' || Boolean(spec.cards?.length);
}

export function isAuthentication(spec: TemplateSpec): boolean {
  return spec.category?.toUpperCase() === 'AUTHENTICATION';
}

export function hasLimitedTimeOffer(spec: TemplateSpec): boolean {
  return Boolean(spec.ltoText?.trim());
}
