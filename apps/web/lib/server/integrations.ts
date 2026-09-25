import { prisma } from './db';
import { decryptField, encryptField } from './pii';

export type IntegrationConfig = Record<string, any>;

export async function getIntegration(orgId: string, provider: string, shopId?: string | null) {
  const list = await prisma.integration.findMany({ where: { organizationId: orgId, provider } });
  const it = list.find((i) => i.shopId === (shopId ?? null)) ?? list.find((i) => i.shopId === null) ?? list[0];
  if (!it) return null;
  return { integration: it, config: readConfig(it.configEnc) };
}

export function readConfig(configEnc: string | null): IntegrationConfig {
  if (!configEnc) return {};
  try { return JSON.parse(decryptField(configEnc) ?? '{}'); } catch { return {}; }
}

export function writeConfig(config: IntegrationConfig): string | null {
  return encryptField(JSON.stringify(config));
}
