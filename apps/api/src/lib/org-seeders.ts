import type { Ctx } from '../auth/actor.js';

/**
 * Modules register default data to create for every new organization
 * (system roles, message templates, karte/form templates, feature flags...).
 * Seeders run in registration order inside the signup transaction.
 */
export type OrgSeeder = (ctx: Ctx, input: { organizationId: string; shopId: string; ownerStaffId: string }) => Promise<void>;

const seeders: { name: string; order: number; fn: OrgSeeder }[] = [];

export function registerOrgSeeder(name: string, fn: OrgSeeder, order = 100) {
  seeders.push({ name, order, fn });
  seeders.sort((a, b) => a.order - b.order);
}

export async function runOrgSeeders(ctx: Ctx, input: Parameters<OrgSeeder>[1]) {
  for (const s of seeders) await s.fn(ctx, input);
}
