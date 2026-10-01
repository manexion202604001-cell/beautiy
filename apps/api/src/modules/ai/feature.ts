import type { Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';

/**
 * AI features can be switched off per organization (organizations.settings.ai_assist === false).
 * Read directly from organizations.settings — the feature-flag module may later wrap this.
 */
export async function isAiEnabled(ctx: Ctx): Promise<boolean> {
  const org = await ctx.trx.selectFrom('organizations').select('settings').where('id', '=', ctx.actor.organizationId).executeTakeFirst();
  return (org?.settings as { ai_assist?: unknown } | null)?.ai_assist !== false;
}

export async function assertAiEnabled(ctx: Ctx): Promise<void> {
  if (!(await isAiEnabled(ctx))) throw Errors.forbidden('この法人ではAIアシスト機能が無効になっています', 'AI_DISABLED');
}
