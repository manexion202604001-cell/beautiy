/**
 * Public contract of the auth module for other modules.
 */
import type { Ctx } from '../../auth/actor.js';

/**
 * End every open session of a login account, inside the caller's transaction. Called when someone
 * other than the account's owner sets a new password (スタッフ › ログイン情報), so that devices signed
 * in with the previous password have to sign in again.
 */
export async function revokeUserSessions(ctx: Ctx, userId: string): Promise<void> {
  await ctx.trx.updateTable('auth_sessions').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
}
