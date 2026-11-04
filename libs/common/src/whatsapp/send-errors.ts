/**
 * What to do about each error Meta returns when a message is sent.
 *
 * Without this everything looks the same: the send throws, the queue retries three times,
 * and the recipient is marked failed on every attempt. That is wrong in both directions.
 * A customer who has turned off marketing messages gets three more attempts Meta has
 * already said will never arrive, and a broken template burns one API call per recipient
 * per attempt across the whole list.
 *
 * Codes and their meanings come from the Cloud API error reference.
 */

export type SendErrorAction =
  /** Transient. Let the queue try again with its backoff. */
  | 'RETRY'
  /** Permanent for this recipient only. Fail them, move on, never retry. */
  | 'DROP'
  /** This person has opted out. Fail them and stop sending to this number entirely. */
  | 'SUPPRESS'
  /** The account or the template is broken. Every other recipient will fail the same way. */
  | 'ABORT';

export interface SendErrorRule {
  action: SendErrorAction;
  /** Shown on the recipient row, or on the campaign when the action is ABORT. */
  reason: string;
  /** Roughly how long until this would be worth trying again, for the UI to explain. */
  retryAfterHours?: number;
}

/**
 * Every code we have a considered answer for. Anything absent is treated as retryable,
 * because an unknown failure is more often a blip than a permanent state.
 */
const RULES: Record<number, SendErrorRule> = {
  // ── The recipient has opted out ────────────────────────────────────────────
  131050: {
    action: 'SUPPRESS',
    reason: 'This person turned off marketing messages from your business on WhatsApp.',
  },

  // ── Permanent for this recipient ───────────────────────────────────────────
  131026: {
    action: 'DROP',
    reason: 'Not reachable on WhatsApp. The number may not have an account, or has not accepted WhatsApp’s current terms.',
  },
  131021: {
    action: 'DROP',
    reason: 'That is your own WhatsApp number. A business cannot message itself.',
  },
  131051: {
    action: 'DROP',
    reason: 'WhatsApp does not support this message type for this recipient.',
  },
  131049: {
    action: 'DROP',
    reason: 'This person has already had as many marketing messages as WhatsApp allows for now. Trying again today would extend the block.',
    retryAfterHours: 24,
  },
  131047: {
    action: 'DROP',
    reason: 'More than 24 hours since they last replied, so only an approved template can reach them.',
  },
  132005: {
    action: 'DROP',
    reason: 'The filled-in template is too long for this recipient’s values.',
  },
  132012: {
    action: 'DROP',
    reason: 'One of this recipient’s values does not match the format the template expects.',
  },

  // ── Transient ─────────────────────────────────────────────────────────────
  1:      { action: 'RETRY', reason: 'WhatsApp returned a temporary error.' },
  2:      { action: 'RETRY', reason: 'WhatsApp is temporarily unavailable.' },
  4:      { action: 'RETRY', reason: 'Too many API calls for now.' },
  80007:  { action: 'RETRY', reason: 'Your WhatsApp account’s sending rate was exceeded.' },
  130429: { action: 'RETRY', reason: 'WhatsApp’s sending rate for your number was exceeded.' },
  131056: { action: 'RETRY', reason: 'Too many messages to this number in a short time.' },
  131057: { action: 'RETRY', reason: 'Your WhatsApp account is being upgraded.' },
  132069: { action: 'RETRY', reason: 'This flow has sent its hourly limit of messages.' },

  // ── The account cannot send at all ────────────────────────────────────────
  0:      { action: 'ABORT', reason: 'WhatsApp rejected the access token. Reconnect WhatsApp in Settings.' },
  3:      { action: 'ABORT', reason: 'The connected app is missing a permission it needs to send.' },
  10:     { action: 'ABORT', reason: 'Permission to send was removed from the connected app.' },
  33:     { action: 'ABORT', reason: 'The sending phone number no longer exists on WhatsApp.' },
  190:    { action: 'ABORT', reason: 'The WhatsApp access token has expired. Reconnect WhatsApp in Settings.' },
  368:    { action: 'ABORT', reason: 'WhatsApp has temporarily blocked this account for a policy violation.' },
  131031: { action: 'ABORT', reason: 'WhatsApp has restricted this account. Check its status in WhatsApp Manager.' },
  131042: { action: 'ABORT', reason: 'WhatsApp cannot bill this account. Check the payment method on the Meta business account.' },
  131045: { action: 'ABORT', reason: 'The sending phone number is not registered with WhatsApp.' },
  131048: {
    action: 'ABORT',
    reason: 'WhatsApp has throttled this number because too many recipients blocked or reported its messages. Sending more makes it worse.',
  },
  133010: { action: 'ABORT', reason: 'The sending phone number is not registered on the WhatsApp platform.' },

  // ── The message itself is wrong for everyone ──────────────────────────────
  131008: { action: 'ABORT', reason: 'The message is missing a required field.' },
  131052: { action: 'ABORT', reason: 'WhatsApp could not download the media in this template.' },
  131053: { action: 'ABORT', reason: 'WhatsApp rejected the media in this template. Check the file type.' },
  135000: { action: 'ABORT', reason: 'WhatsApp rejected the message as malformed.' },

  // ── The template is wrong or unusable ─────────────────────────────────────
  132000: { action: 'ABORT', reason: 'The template expects a different number of variables than the campaign supplies.' },
  132001: { action: 'ABORT', reason: 'That template does not exist, or is not approved in this language.' },
  132007: { action: 'ABORT', reason: 'The template’s content breaks WhatsApp’s policy.' },
  132015: { action: 'ABORT', reason: 'WhatsApp paused this template for low quality. Edit it and submit it again.' },
  132016: { action: 'ABORT', reason: 'WhatsApp disabled this template permanently. Build a new one.' },
  132018: { action: 'ABORT', reason: 'WhatsApp rejected the template’s variables.' },
  132068: { action: 'ABORT', reason: 'The flow on this template is blocked.' },

  // ── The request itself is not valid for this account ──────────────────────
  // Meta's catch-all "invalid parameter". Whatever is wrong is wrong identically for
  // every recipient, so retrying is pointless — hence ABORT rather than the RETRY an
  // unrecognised code would otherwise get. See SUBCODE_RULES for the specific cases.
  100: { action: 'ABORT', reason: 'WhatsApp rejected one of the values in this request.' },
};

/**
 * Rules that need Meta's subcode as well as its code, keyed `code:subcode`. Checked
 * before RULES, so a subcode we recognise wins over the broader code's answer.
 */
const SUBCODE_RULES: Record<string, SendErrorRule> = {
  // The sending number (or its WhatsApp Business Account) is not visible to the app
  // that issued the token: it was deleted, moved to another app, or — for one of Meta's
  // free test numbers — recycled. The credentials are intact; the number is gone, so no
  // amount of retrying brings it back and every send from it fails the same way.
  '100:33': {
    action: 'ABORT',
    reason: 'This WhatsApp number is no longer connected in Meta. Reconnect it in Settings.',
  },
};

const UNKNOWN: SendErrorRule = {
  action: 'RETRY',
  reason: 'WhatsApp returned an error we do not recognise.',
};

/** The error Meta sent, flattened out of the Graph response. */
export interface ParsedSendError {
  code: number | null;
  /** Meta's `error_subcode`, which separates the many meanings of a broad code like 100. */
  subcode: number | null;
  title: string | null;
  /** Meta's own message, which is more specific than our reason and worth keeping. */
  message: string | null;
  details: string | null;
  httpStatus: number;
}

/**
 * Pulls the error out of a Graph API response body. Meta nests it under `error`, with the
 * useful part sometimes a level deeper under `error_data.details`.
 */
export function parseSendError(httpStatus: number, body: unknown): ParsedSendError {
  const error = (body as any)?.error ?? {};
  const code = typeof error.code === 'number' ? error.code : null;
  return {
    code,
    subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
    title: error.error_user_title ?? error.type ?? null,
    message: error.message ?? null,
    details: error.error_data?.details ?? error.error_user_msg ?? null,
    httpStatus,
  };
}

/**
 * @param subcode Meta's `error_subcode` when the caller has it. Callers reading a code
 *   back from a stored column have only the code, which still resolves correctly.
 */
export function classifySendError(
  code: number | null | undefined,
  subcode?: number | null,
): SendErrorRule {
  if (code == null) return UNKNOWN;
  if (subcode != null) {
    const specific = SUBCODE_RULES[`${code}:${subcode}`];
    if (specific) return specific;
  }
  return RULES[code] ?? UNKNOWN;
}

/** Whether we have a considered answer for this code, or are falling back to a retry. */
export function isKnownSendError(
  code: number | null | undefined,
  subcode?: number | null,
): boolean {
  if (code == null) return false;
  return (subcode != null && `${code}:${subcode}` in SUBCODE_RULES) || code in RULES;
}

/**
 * The line to store against a failed recipient: our explanation, plus Meta's own wording
 * when it adds something, and the code so it can be looked up.
 */
export function describeSendError(parsed: ParsedSendError, rule: SendErrorRule): string {
  const extra = parsed.details ?? parsed.message ?? null;
  const code = parsed.code ? ` (WhatsApp error ${parsed.code})` : '';
  // Meta often repeats what we already say, so only add it when it differs.
  const suffix = extra && !rule.reason.includes(extra) ? ` ${extra}` : '';
  return `${rule.reason}${suffix}${code}`.slice(0, 500);
}
