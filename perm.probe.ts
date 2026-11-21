import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import { PERMISSIONS, accountCeiling, roleDefaults, resolvePermission } from './libs/common/src/permissions';
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL'] }) }) as any;

(async () => {
  const u = await p.user.findFirst({
    where: { email: 'owner@resellerw.test' },
    select: { id: true, role: true, userPermissions: { select: { permission: true, allowed: true } },
      tenant: { select: { name: true, accountType: true, resellerType: true } } },
  });
  const { accountType, resellerType } = u.tenant;
  console.log(`${u.tenant.name} · ${accountType}/${resellerType} · role ${u.role}`);

  const rows = await p.rolePermission.findMany({
    where: { accountType, role: u.role }, select: { accountType: true, role: true, permission: true, allowed: true },
  }).catch(() => []);
  const roleOverrides = new Map(rows.map((r: any) => [`${r.accountType}:${r.role}:${r.permission}`, r.allowed]));
  const userOverrides = new Map(u.userPermissions.map((x: any) => [x.permission, x.allowed]));
  const ceiling = accountCeiling(accountType, resellerType) as readonly string[];
  const principal = { role: u.role, accountType, resellerType };

  console.log(`ceiling allows ${ceiling.length} of ${PERMISSIONS.length} permissions`);
  console.log(`role defaults : ${roleDefaults(u.role, accountType).length}`);
  console.log(`user overrides: ${u.userPermissions.length}`);
  console.log('\nthe ones the reseller screens need:');
  for (const perm of ['reseller.clients.view','reseller.clients.manage','reseller.commissions.view','reseller.plans.manage','whitelabel.manage','billing.manage','users.manage','settings.manage']) {
    const inCeiling = ceiling.includes(perm);
    const eff = resolvePermission(principal as any, perm as any, roleOverrides as any, userOverrides as any);
    console.log(`  ${perm.padEnd(28)} ceiling=${String(inCeiling).padEnd(5)} effective=${eff}`);
  }
})().catch(e => console.error(e.message)).finally(() => p.$disconnect());
