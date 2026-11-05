import { BadRequestException } from '@nestjs/common';

export interface BulkPriceChange {
  /** Percentage to move by, signed: 10 raises by a tenth, -5 cuts by a twentieth. */
  percent?: number;
  /** Flat amount in minor units, signed. Applied instead of `percent`, never as well. */
  flatMinor?: number;
  /** Nothing is written when true — the caller gets the before-and-after to confirm. */
  dryRun?: boolean;
  /** Prices are whole minor units; this decides which way a fraction goes. */
  rounding?: 'nearest' | 'up' | 'down';
}

export interface BulkPriceLine {
  id: string;
  label: string;
  before: number;
  after: number;
}

/**
 * Works out a bulk price change without applying it.
 *
 * Prices were only ever editable one at a time, so putting every price up by a few per
 * cent meant a row of manual edits and a fair chance of missing one. This computes the
 * whole set at once, and because that is a sweeping change it is built to be previewed:
 * the caller sees every before-and-after line and applies it as a second step.
 *
 * Rounding is explicit rather than implied. Prices are whole minor units, so a
 * percentage almost always lands on a fraction, and silently truncating turns a rise
 * into no change at all on the cheapest rates — which is exactly where it would go
 * unnoticed.
 */
export function computeBulkPrices(
  items: Array<{ id: string; label: string; priceMinor: number }>,
  change: BulkPriceChange,
): BulkPriceLine[] {
  const hasPercent = change.percent !== undefined && change.percent !== null;
  const hasFlat    = change.flatMinor !== undefined && change.flatMinor !== null;

  if (hasPercent === hasFlat) {
    throw new BadRequestException('Give either percent or flatMinor, not both.');
  }
  if (hasPercent && (change.percent! < -90 || change.percent! > 500)) {
    throw new BadRequestException('percent must be between -90 and 500.');
  }

  const round = (n: number) => {
    switch (change.rounding) {
      case 'up':   return Math.ceil(n);
      case 'down': return Math.floor(n);
      default:     return Math.round(n);
    }
  };

  return items.map((item) => {
    const raw = hasPercent
      ? item.priceMinor * (1 + change.percent! / 100)
      : item.priceMinor + change.flatMinor!;

    // A price may reach zero — free — but never go below it, which would mean paying
    // people to receive messages.
    const after = Math.max(0, round(raw));
    return { id: item.id, label: item.label, before: item.priceMinor, after };
  });
}
