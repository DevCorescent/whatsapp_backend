export const PERMISSIONS = [
  'contacts.view', 'contacts.manage', 'contacts.delete', 'contacts.import', 'contacts.export',
  'conversations.view', 'messages.send',
  'campaigns.view', 'campaigns.send', 'templates.manage',
  'blacklist.view', 'blacklist.manage', 'reports.view',
  'users.manage', 'billing.manage', 'settings.manage',
  'reseller.clients.view', 'reseller.clients.manage', 'reseller.plans.manage', 'reseller.commissions.view',
  'whitelabel.manage',
] as const;

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
    case 'PLATFORM': return PERMISSIONS;
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

export function roleDefaults(role: string): readonly Permission[] {
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

  return (roleDefaults(principal.role) as readonly string[]).includes(permission);
}

/** Roles an owner or admin may hand out. TENANT_OWNER is never one of them — an account has exactly one owner. */
export const INVITABLE_ROLES = ['ADMIN', 'MANAGER', 'MARKETING_USER', 'AGENT'] as const;

/** Roles that may manage team members and their permissions. */
export const TEAM_ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_OWNER', 'ADMIN'] as const;

export function isInvitableRole(role: string | null | undefined): boolean {
  return (INVITABLE_ROLES as readonly string[]).includes(role ?? '');
}
