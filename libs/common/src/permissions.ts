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

export function resolvePermission(
  principal: { role: string; accountType?: string | null; resellerType?: string | null } | null,
  permission: Permission,
  overrideMap: Map<string, boolean> = new Map(),
): boolean {
  if (!principal?.role) return false;
  if (principal.role === 'SUPER_ADMIN') return true;
  const accountType = principal.accountType ?? 'CLIENT';
  if (!(accountCeiling(accountType, principal.resellerType) as readonly string[]).includes(permission)) return false;
  const key = `${accountType}:${principal.role}:${permission}`;
  const override = overrideMap.get(key);
  if (override !== undefined) return override;
  return (roleDefaults(principal.role) as readonly string[]).includes(permission);
}
