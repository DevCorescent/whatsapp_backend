import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@lib/prisma';

export type WalletTxnKind = 'TOPUP' | 'DEBIT' | 'REFUND' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT';

export interface WalletMovementOpts {
  type?: WalletTxnKind;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  /** Makes the movement happen at most once; a repeat is reported as `duplicate`. */
  idempotencyKey?: string | null;
  createdById?: string | null;
  /**
   * Debits only. When the balance is short:
   *   true  (default) — take what is there and leave the wallet at zero
   *   false           — change nothing and report the shortfall
   */
  allowPartial?: boolean;
}

export interface WalletMovement {
  /** Signed paise actually applied: positive credit, negative debit. 0 when nothing moved. */
  appliedMinor: number;
  /** Balance afterwards. Never negative. */
  balanceMinor: number;
  /** Requested debit that could not be taken because the balance ran out. */
  shortfallMinor: number;
  /** The idempotency key had already been used, so this call changed nothing. */
  duplicate: boolean;
}

/**
 * The one place a wallet balance changes.
 *
 * A balance is never negative: a debit takes at most what is there. Some callers
 * (subscription-style fees) want all-or-nothing instead and pass `allowPartial: false`,
 * which leaves the wallet untouched and reports the shortfall rather than part-charging.
 *
 * Every movement writes one WalletTransaction whose `amountMinor` is signed — positive
 * credit, negative debit, as the column documents — and whose `balanceAfterMinor` is the
 * real balance, so the statement always reconciles with the wallet.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  async balance(tenantId: string): Promise<number> {
    const wallet = await this.prisma.wallet.findUnique({ where: { tenantId }, select: { balanceMinor: true } });
    return Math.max(0, wallet?.balanceMinor ?? 0);
  }

  async ensure(tenantId: string) {
    return this.prisma.wallet.upsert({
      where:  { tenantId },
      create: { tenantId, balanceMinor: 0 },
      update: {},
    });
  }

  /** Add money. `amountMinor` must be positive. */
  credit(tenantId: string, amountMinor: number, opts: WalletMovementOpts = {}): Promise<WalletMovement> {
    const amount = this.positive(amountMinor, 'Credit');
    return this.move(tenantId, amount, { type: 'TOPUP', ...opts });
  }

  /** Take money, never past zero. `amountMinor` must be positive. */
  debit(tenantId: string, amountMinor: number, opts: WalletMovementOpts = {}): Promise<WalletMovement> {
    const amount = this.positive(amountMinor, 'Debit');
    return this.move(tenantId, -amount, { type: 'DEBIT', ...opts });
  }

  /**
   * A signed adjustment, which is what a manual operator action is: positive adds,
   * negative deducts. Deducting more than the balance leaves the wallet at zero and
   * reports the shortfall — the operator is never blocked from entering the amount.
   */
  adjust(tenantId: string, signedMinor: number, opts: WalletMovementOpts = {}): Promise<WalletMovement> {
    if (!Number.isFinite(signedMinor) || Math.round(signedMinor) === 0) {
      throw new BadRequestException('Enter an amount other than zero');
    }
    return this.move(tenantId, Math.round(signedMinor), { type: 'ADJUSTMENT', ...opts });
  }

  /**
   * Move credit between two wallets in one transaction, with a statement line on each
   * side. All-or-nothing: if the sender cannot cover it, nothing moves.
   */
  async transfer(
    fromTenantId: string,
    toTenantId: string,
    amountMinor: number,
    opts: { description?: string | null; createdById?: string | null; referenceType?: string | null; referenceId?: string | null } = {},
  ): Promise<{ fromBalanceMinor: number; toBalanceMinor: number; amountMinor: number }> {
    const amount = this.positive(amountMinor, 'Transfer');
    if (fromTenantId === toTenantId) throw new BadRequestException('Cannot transfer to the same account');

    await Promise.all([this.ensure(fromTenantId), this.ensure(toTenantId)]);

    return this.prisma.$transaction(async (tx) => {
      const taken = await tx.wallet.updateMany({
        where: { tenantId: fromTenantId, balanceMinor: { gte: amount } },
        data:  { balanceMinor: { decrement: amount } },
      });
      if (taken.count === 0) throw new BadRequestException('Insufficient wallet balance');

      const from = await tx.wallet.findUniqueOrThrow({ where: { tenantId: fromTenantId }, select: { balanceMinor: true } });
      const to = await tx.wallet.update({
        where:  { tenantId: toTenantId },
        data:   { balanceMinor: { increment: amount } },
        select: { balanceMinor: true },
      });

      await tx.walletTransaction.createMany({
        data: [
          {
            tenantId: fromTenantId, type: 'TRANSFER_OUT' as never, amountMinor: -amount,
            balanceAfterMinor: from.balanceMinor, description: opts.description ?? 'Transfer to client',
            referenceType: opts.referenceType ?? 'wallet_transfer', referenceId: opts.referenceId ?? toTenantId,
            createdById: opts.createdById ?? null,
          },
          {
            tenantId: toTenantId, type: 'TRANSFER_IN' as never, amountMinor: amount,
            balanceAfterMinor: to.balanceMinor, description: opts.description ?? 'Transfer from reseller',
            referenceType: opts.referenceType ?? 'wallet_transfer', referenceId: opts.referenceId ?? fromTenantId,
            createdById: opts.createdById ?? null,
          },
        ],
      });

      return { fromBalanceMinor: from.balanceMinor, toBalanceMinor: to.balanceMinor, amountMinor: amount };
    });
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private positive(amountMinor: number, label: string): number {
    const amount = Math.round(amountMinor);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException(`${label} amount must be more than zero`);
    return amount;
  }

  private async move(tenantId: string, signedMinor: number, opts: WalletMovementOpts): Promise<WalletMovement> {
    const allowPartial = opts.allowPartial !== false;

    if (opts.idempotencyKey) {
      const seen = await this.prisma.walletTransaction.findUnique({
        where:  { idempotencyKey: opts.idempotencyKey },
        select: { balanceAfterMinor: true, amountMinor: true },
      });
      if (seen) {
        return { appliedMinor: 0, balanceMinor: Math.max(0, seen.balanceAfterMinor), shortfallMinor: 0, duplicate: true };
      }
    }

    await this.ensure(tenantId);

    return this.prisma.$transaction(async (tx) => {
      const current = (await tx.wallet.findUniqueOrThrow({ where: { tenantId }, select: { balanceMinor: true } })).balanceMinor;
      // A balance already below zero (legacy data) is treated as empty, never deepened.
      const available = Math.max(0, current);

      let applied = signedMinor;
      let shortfall = 0;

      if (signedMinor < 0) {
        const wanted = -signedMinor;
        const take = Math.min(wanted, available);
        shortfall = wanted - take;
        if (shortfall > 0 && !allowPartial) {
          return { appliedMinor: 0, balanceMinor: available, shortfallMinor: shortfall, duplicate: false };
        }
        applied = -take;
      }

      const balanceMinor = Math.max(0, available + applied);

      if (applied === 0 && opts.type !== 'ADJUSTMENT') {
        // Nothing to take and nothing to record beyond the shortfall.
        if (current !== balanceMinor) {
          await tx.wallet.update({ where: { tenantId }, data: { balanceMinor } });
        }
        return { appliedMinor: 0, balanceMinor, shortfallMinor: shortfall, duplicate: false };
      }

      await tx.wallet.update({ where: { tenantId }, data: { balanceMinor } });
      await tx.walletTransaction.create({
        data: {
          tenantId,
          type:              (opts.type ?? (applied >= 0 ? 'TOPUP' : 'DEBIT')) as never,
          amountMinor:       applied,
          balanceAfterMinor: balanceMinor,
          description:       opts.description ?? null,
          referenceType:     opts.referenceType ?? null,
          referenceId:       opts.referenceId ?? null,
          idempotencyKey:    opts.idempotencyKey ?? null,
          createdById:       opts.createdById ?? null,
        },
      });

      return { appliedMinor: applied, balanceMinor, shortfallMinor: shortfall, duplicate: false };
    });
  }
}
