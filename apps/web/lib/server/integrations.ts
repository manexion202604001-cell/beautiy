import { prisma } from './db';
import { decryptField, encryptField } from './pii';

export type IntegrationConfig = Record<string, any>;

/**
 * The integration that applies to a shop: the shop's own row, else the org-level row
 * (shopId null). Never another shop's row — that would e.g. charge a customer on, or send
 * LINE messages from, a different shop's account. Callers check `status` (PAUSED).
 */
export async function getIntegration(orgId: string, provider: string, shopId?: string | null) {
  const list = await prisma.integration.findMany({
    where: { organizationId: orgId, provider, OR: [{ shopId: null }, ...(shopId ? [{ shopId }] : [])] }, orderBy: { createdAt: 'asc' },
  });
  const it = (shopId ? list.find((i) => i.shopId === shopId) : undefined) ?? list.find((i) => i.shopId === null);
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
