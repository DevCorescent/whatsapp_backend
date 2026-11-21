/**
 * One canonical form for every phone number we store: digits only, no `+`.
 *
 * That is the form WhatsApp itself uses — a webhook's `wa_id` is bare digits — and most
 * contacts arrive that way, created from an inbound message. The dashboard's phone field,
 * though, produces `+91…`, and nothing reconciled the two: both were written verbatim, so
 * `contacts(phone, businessId)` was unique over two spellings of the same person. One
 * number could exist twice in a business, each half with its own conversation, and the
 * review screen then rendered `+` in front of a number that already had one — `++91…`.
 *
 * Normalise on the way in, add the `+` only when displaying. Never store it.
 */

/** Digits only, `+` and separators removed, a leading international `00` dropped. */
export function normalizePhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  // 00 is the other way of writing +, and a number can genuinely begin with 0 after its
  // country code, so only strip it when it opens the string.
  return digits.startsWith('00') ? digits.slice(2) : digits;
}

/**
 * Normalises and rejects what cannot be a number, for the places that take one from a
 * person. E.164 allows 15 digits; below 8 nothing is dialable internationally.
 */
export function requirePhone(raw: string, field = 'phone'): string {
  const phone = normalizePhone(raw);
  if (phone.length < 8 || phone.length > 15) {
    throw new Error(`${field} must be a phone number with its country code, like 919876543210.`);
  }
  return phone;
}

/**
 * The same number, with a country code on the front when it plainly has none.
 *
 * Numbers are pasted into this product by people, from spreadsheets and phone contacts,
 * and in India they are written as ten digits. The blacklist screen says so — "numbers
 * without a country code get +91" — and nothing did it, so a number blocked as
 * 9865856989 never matched a contact stored as 919865856989 and the block silently did
 * nothing at all.
 *
 * Only a bare ten-digit number is assumed to be national; anything else is already
 * carrying its own code and is left alone.
 */
export function withCountryCode(raw: string, defaultCode?: string): string {
  const digits = normalizePhone(raw);
  // Guarded because this is handed straight to `.map`, which calls it with the index as
  // a second argument — and a number there silently became the country code.
  const given = typeof defaultCode === 'string' ? defaultCode : undefined;
  const code = (given ?? process.env['DEFAULT_COUNTRY_CODE'] ?? '91').replace(/\D/g, '');
  if (!digits || !code) return digits;
  return digits.length === 10 ? `${code}${digits}` : digits;
}

/** With the `+` back on, for display and for anything shown to a customer. */
export function displayPhone(phone: string): string {
  const digits = normalizePhone(phone);
  return digits ? `+${digits}` : '';
}
