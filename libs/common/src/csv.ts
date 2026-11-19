/**
 * Writing cells a spreadsheet reads back the way they were meant.
 *
 * Two different problems, often confused:
 *
 *  · A cell that starts with `=`, `+`, `-` or `@` is a formula to Excel, so exported
 *    customer text could execute on whoever opened it. That one is solved by an
 *    apostrophe.
 *
 *  · A long run of digits is a *number* to Excel, and quoting it changes nothing —
 *    "919589708682" still opens as 9.19589E+11, and a number beginning with a zero
 *    loses it. Phone numbers are the column this ruins, which is exactly the column
 *    an exported contact list exists for.
 *
 * The second needs `="919589708682"`, which Excel evaluates to the text. It costs
 * something: a program reading the file sees the formula rather than the digits. Worth
 * it on the phone column alone, where the alternative is a file whose numbers cannot be
 * dialled, and not used anywhere else.
 */

/** A cell a spreadsheet might run as a formula, made inert. */
export function csvCell(value: unknown): string {
  const s = String(value ?? '');
  const looksLikeFormula = /^[=+\-@]/.test(s) && !/^[+-]?[\d\s()\-+]+$/.test(s);
  const safe = looksLikeFormula ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * A phone number that survives being opened in Excel, shown in full with its country
 * code. Stored numbers are digits only, so the `+` is added back here — it is what
 * anyone reading the file needs in order to dial it.
 */
export function csvPhone(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '""';

  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return csvCell(raw);

  // The formula's own quotes are doubled, like any quoted cell.
  return `"=""+${digits}"""`;
}
