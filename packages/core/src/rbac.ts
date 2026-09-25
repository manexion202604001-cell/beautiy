// Role-based access control. Authorization is always enforced server-side.

export const ROLES = ['OWNER', 'DIRECTOR', 'MANAGER', 'STYLIST', 'ASSISTANT', 'RECEPTION'] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_LABEL: Record<RoleName, string> = {
  OWNER: 'オーナー', DIRECTOR: 'ディレクター', MANAGER: '店長', STYLIST: 'スタイリスト', ASSISTANT: 'アシスタント', RECEPTION: '受付',
};

export const PERMISSIONS = [
  'customer.read', 'customer.write', 'customer.pii', 'customer.merge', 'customer.export', 'customer.import',
  'appointment.read', 'appointment.write',
  'karte.read', 'karte.write',
  'pos.checkout', 'pos.refund', 'pos.register',
  'message.send', 'message.broadcast', 'message.automation',
  'report.read', 'report.export',
  'review.reply', 'profile.edit',
  'settings.shop', 'settings.staff', 'settings.menu', 'settings.integrations', 'settings.permissions',
  'commerce.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const without = (...p: Permission[]) => new Set<Permission>(PERMISSIONS.filter((x) => !p.includes(x)));

export const ROLE_PERMISSIONS: Record<RoleName, Set<Permission>> = {
  OWNER: ALL,
  DIRECTOR: without('settings.permissions'),
  MANAGER: without('settings.permissions', 'settings.integrations', 'audit.read', 'customer.import'),
  STYLIST: new Set<Permission>([
    'customer.read', 'customer.write', 'appointment.read', 'appointment.write', 'karte.read', 'karte.write',
    'pos.checkout', 'message.send', 'review.reply', 'profile.edit', 'report.read',
  ]),
  ASSISTANT: new Set<Permission>(['customer.read', 'appointment.read', 'appointment.write', 'karte.read', 'karte.write']),
  RECEPTION: new Set<Permission>([
    'customer.read', 'customer.write', 'appointment.read', 'appointment.write', 'karte.read', 'pos.checkout', 'pos.register', 'message.send',
  ]),
};

/** PII visible by default for these roles; others need membership.canViewPII or a temporary unlock. */
export const PII_DEFAULT_ROLES: RoleName[] = ['OWNER', 'DIRECTOR', 'MANAGER'];

export function can(role: RoleName, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}

export function outranks(a: RoleName, b: RoleName): boolean {
  return ROLES.indexOf(a) < ROLES.indexOf(b);
}
