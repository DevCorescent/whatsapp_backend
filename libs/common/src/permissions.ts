export const PERMISSIONS = [
  'contacts.view', 'contacts.manage', 'contacts.delete', 'contacts.import', 'contacts.export',
  'conversations.view', 'messages.send',
  'campaigns.view', 'campaigns.send', 'templates.manage',
  'blacklist.view', 'blacklist.manage', 'reports.view',
  'users.manage', 'billing.manage', 'settings.manage',
  'reseller.clients.view', 'reseller.clients.manage', 'reseller.plans.manage', 'reseller.commissions.view',
  'whitelabel.manage',

  // ── Running the platform itself ──
  // Separate from everything above, which is about one account's own work. These decide
  // who may act on *other people's* accounts, and they exist so that running the platform
  // does not have to mean holding every power in it: a Super Admin can take on staff and
  // hand each of them only the part they need.
  'platform.tenants.view',       // see accounts, their plans, wallets and numbers
  'platform.tenants.manage',     // change them: plan, wallet, suspension, reset a password
  'platform.secrets.reveal',     // read a client's WhatsApp token in the clear
  'platform.plans.manage',       // the plans on offer
  'platform.pricing.manage',     // message rates, bulk price changes, plan-end policy
  'platform.revenue.view',       // revenue, reports, commissions
  'platform.commissions.manage', // pay or adjust a reseller's commission
  'platform.categories.manage',  // the account categories
  'platform.cms.manage',         // the marketing site's copy
  'platform.whitelabel.manage',  // the platform's own branding
  'platform.audit.view',         // what everyone has been doing
  'platform.staff.manage',       // take on admins and decide what they may do
  'platform.impersonate',        // open someone's account, or sign in as one of their people
] as const;

/** The platform-only half, for the admin screens that present them on their own. */
export const PLATFORM_PERMISSIONS = PERMISSIONS.filter((p) => p.startsWith('platform.'));

export type Permission = (typeof PERMISSIONS)[number];

const CLIENT_FEATURES: Permission[] = [
  'contacts.view', 'contacts.manage', 'contacts.delete', 'contacts.import', 'contacts.export',
  'conversations.view', 'messages.send',
  'campaigns.view', 'campaigns.send', 'templates.manage',
  'blacklist.view', 'blacklist.manage', 'reports.view',
];
const ACCOUNT_ADMIN: Permission[] = ['users.manage', 'billing.manage', 'settings.manage'];
const RESELLER_FEATURES: Permission[] = [
  'reseller.clients.view', 'reseller.clients.manage', 'reseller.plans.manage', 'reseller.commissions.view',
];

export function accountCeiling(
  accountType?: string | null,
  resellerType?: string | null,
): readonly Permission[] {
  switch (accountType) {
    case 'PLATFORM': return PERMISSIONS;  // the platform account can hold anything
    case 'RESELLER': return [
      ...RESELLER_FEATURES,
      ...ACCOUNT_ADMIN,
      ...(resellerType === 'WHITE_LABEL' ? (['whitelabel.manage'] as Permission[]) : []),
    ];
    default: return [...CLIENT_FEATURES, ...ACCOUNT_ADMIN];
  }
}

const ROLE_DEFAULTS: Record<string, readonly Permission[]> = {
  SUPER_ADMIN:    PERMISSIONS,
  TENANT_OWNER:   PERMISSIONS,
  ADMIN:          PERMISSIONS,
  MANAGER: [
    'contacts.view', 'contacts.manage', 'contacts.import', 'contacts.export',
    'conversations.view', 'messages.send',
    'campaigns.view', 'campaigns.send', 'templates.manage',
    'blacklist.view', 'reports.view',
    'reseller.clients.view', 'reseller.commissions.view',
  ],
  MARKETING_USER: [
    'contacts.view', 'contacts.manage', 'contacts.import',
    'conversations.view', 'messages.send',
    'campaigns.view', 'campaigns.send', 'templates.manage',
    'blacklist.view', 'reports.view',
    'reseller.clients.view',
  ],
  AGENT: ['contacts.view', 'contacts.manage', 'conversations.view', 'messages.send'],
};

/**
 * What an admin of the platform account starts with: enough to look, nothing that
 * changes anyone's account.
 *
 * An ADMIN of a *client* account is its second-in-command and defaults to everything, so
 * the role alone cannot decide this — the same role means something far larger here. New
 * staff therefore begin able to see the platform and do nothing to it, and each power is
 * handed over deliberately. The alternative, inheriting the client default, would make
 * every new admin as powerful as the Super Admin the moment they were created.
 */
const PLATFORM_ROLE_DEFAULTS: Record<string, readonly Permission[]> = {
  ADMIN: ['platform.tenants.view', 'platform.revenue.view', 'platform.audit.view'],
  MANAGER: ['platform.tenants.view'],
  MARKETING_USER: ['platform.tenants.view'],
  AGENT: [],
};

export function roleDefaults(role: string, accountType?: string | null): readonly Permission[] {
  if (accountType === 'PLATFORM' && role !== 'SUPER_ADMIN') {
    return PLATFORM_ROLE_DEFAULTS[role] ?? [];
  }
  return ROLE_DEFAULTS[role] ?? [];
}

/**
 * Whether a principal holds a permission, resolved through all four layers in order:
 *
 *   1. account ceiling — what this kind of account can ever do (a reseller has no
 *      contacts or chats, so no override can grant them)
 *   2. role default    — ROLE_DEFAULTS for their role
 *   3. role override   — a RolePermission row, keyed `accountType:role:permission`
 *   4. user override   — a UserPermission row for this one person, keyed by permission
 *
 * Later layers win. The per-user layer used to be merged by hand in one service only,
 * so every other caller silently ignored it; it belongs here.
 */
export function resolvePermission(
  principal: { role: string; accountType?: string | null; resellerType?: string | null } | null,
  permission: Permission,
  roleOverrides: Map<string, boolean> = new Map(),
  userOverrides: Map<string, boolean> = new Map(),
): boolean {
  if (!principal?.role) return false;
  if (principal.role === 'SUPER_ADMIN') return true;

  const accountType = principal.accountType ?? 'CLIENT';
  if (!(accountCeiling(accountType, principal.resellerType) as readonly string[]).includes(permission)) return false;

  const userOverride = userOverrides.get(permission);
  if (userOverride !== undefined) return userOverride;

  const roleOverride = roleOverrides.get(`${accountType}:${principal.role}:${permission}`);
  if (roleOverride !== undefined) return roleOverride;

  return (roleDefaults(principal.role, accountType) as readonly string[]).includes(permission);
}

/** Roles an owner or admin may hand out. TENANT_OWNER is never one of them — an account has exactly one owner. */
export const INVITABLE_ROLES = ['ADMIN', 'MANAGER', 'MARKETING_USER', 'AGENT'] as const;

/** Roles that may manage team members and their permissions. */
export const TEAM_ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_OWNER', 'ADMIN'] as const;

export function isInvitableRole(role: string | null | undefined): boolean {
  return (INVITABLE_ROLES as readonly string[]).includes(role ?? '');
}
