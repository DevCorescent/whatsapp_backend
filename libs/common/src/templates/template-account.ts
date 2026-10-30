/**
 * Which connected number to talk to Meta through for a given template.
 *
 * A template lives inside one WhatsApp Business Account, and Meta's template endpoints are
 * scoped to that account: submitting to the wrong one creates a duplicate there, and
 * reading from the wrong one finds nothing. So a template that already records its account
 * must be handled through that account, never through whichever number happens to come
 * back first.
 */

/** Just enough of a WhatsApp integration row to choose between them. */
export interface TemplateAccountCandidate {
  whatsappBusinessId: string | null;
  isDefault:          boolean;
}

/**
 * @param wabaId the account recorded on the template, or null when it has never synced.
 * @returns the integration to use, or undefined when none can serve it. A template with a
 *   recorded account is matched to it or refused — falling back to another account would
 *   quietly submit it somewhere else.
 */
export function pickTemplateAccount<T extends TemplateAccountCandidate>(
  candidates: T[],
  wabaId: string | null | undefined,
): T | undefined {
  if (wabaId) return candidates.find((c) => c.whatsappBusinessId === wabaId);
  return (
    candidates.find((c) => c.isDefault && c.whatsappBusinessId) ??
    candidates.find((c) => c.whatsappBusinessId)
  );
}
