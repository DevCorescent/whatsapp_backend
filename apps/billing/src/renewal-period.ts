export type BillingCycle = 'MONTHLY' | 'ANNUAL';

export function nextRenewalPeriod(
  currentPeriodEnd: Date,
  billingCycle: BillingCycle,
  now: Date,
) {
  const startsAt = currentPeriodEnd > now ? currentPeriodEnd : now;
  const endsAt = new Date(startsAt);
  const day = endsAt.getUTCDate();
  endsAt.setUTCDate(1);
  if (billingCycle === 'ANNUAL') {
    endsAt.setUTCFullYear(endsAt.getUTCFullYear() + 1);
  } else {
    endsAt.setUTCMonth(endsAt.getUTCMonth() + 1);
  }
  const lastDay = new Date(Date.UTC(endsAt.getUTCFullYear(), endsAt.getUTCMonth() + 1, 0)).getUTCDate();
  endsAt.setUTCDate(Math.min(day, lastDay));
  return {
    startsAt,
    endsAt,
  };
}
