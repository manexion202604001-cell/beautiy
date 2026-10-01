import { signStaffAccessToken } from '../../auth/jwt.js';
import { invalidateActorCache } from '../../auth/load-actor.js';
import { config } from '../../config.js';
import { withSystem, type Tx } from '../../db/tenant.js';
import { hashPassword, hashToken, otpCode, randomToken, verifyPassword, verifySignedPayload } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { sendEmail } from '../../lib/mailer.js';

const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const OTP_TTL_MIN = 10;

export interface LoginMeta {
  ip?: string;
  userAgent?: string;
}

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  organizationId: string;
  staffId: string;
};

async function memberships(trx: Tx, userId: string) {
  return trx
    .selectFrom('staffs')
    .innerJoin('organizations', 'organizations.id', 'staffs.organization_id')
    .select([
      'staffs.id as staff_id',
      'staffs.organization_id',
      'organizations.name as organization_name',
      'organizations.slug as organization_slug',
      'organizations.status as organization_status',
    ])
    .where('staffs.user_id', '=', userId)
    .where('staffs.status', '=', 'active')
    .where('staffs.deleted_at', 'is', null)
    .where('organizations.status', 'in', ['active', 'trial'])
    .orderBy('organizations.name')
    .execute();
}

async function issueTokens(trx: Tx, userId: string, organizationId: string, staffId: string, meta: LoginMeta, rotatedFrom?: string): Promise<TokenPair> {
  const refreshToken = randomToken(48);
  await trx
    .insertInto('auth_sessions')
    .values({
      user_id: userId,
      organization_id: organizationId,
      staff_id: staffId,
      refresh_token_hash: hashToken(refreshToken),
      user_agent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
      expires_at: new Date(Date.now() + config.JWT_REFRESH_TTL_SEC * 1000),
      rotated_from: rotatedFrom ?? null,
    })
    .execute();
  const accessToken = await signStaffAccessToken({ sub: userId, org: organizationId, stf: staffId });
  return { accessToken, refreshToken, expiresIn: config.JWT_ACCESS_TTL_SEC, organizationId, staffId };
}

export type LoginResult =
  | ({ status: 'authenticated' } & TokenPair)
  | { status: 'organization_required'; organizations: { id: string; name: string; slug: string }[] }
  | { status: 'mfa_required'; challengeId: string; channel: 'email'; destination: string; devCode?: string };

export async function login(email: string, password: string, organizationId: string | undefined, meta: LoginMeta): Promise<LoginResult> {
  // Run password verification outside the write path so failure counters persist on failure
  const user = await withSystem((trx) =>
    trx.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst(),
  );
  const invalid = Errors.unauthenticated('メールアドレスまたはパスワードが正しくありません', 'INVALID_CREDENTIALS');
  if (!user) {
    await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); // equalize timing
    throw invalid;
  }
  if (user.status !== 'active') throw Errors.unauthenticated('アカウントが無効です', 'ACCOUNT_DISABLED');
  if (user.locked_until && user.locked_until > new Date()) {
    throw Errors.unauthenticated('ログイン試行回数が上限を超えました。しばらくしてから再試行してください', 'ACCOUNT_LOCKED');
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    await withSystem((trx) =>
      trx
        .updateTable('users')
        .set((eb) => ({
          failed_login_count: eb('failed_login_count', '+', 1),
          locked_until: user.failed_login_count + 1 >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        }))
        .where('id', '=', user.id)
        .execute(),
    );
    throw invalid;
  }

  return withSystem(async (trx) => {
    await trx.updateTable('users').set({ failed_login_count: 0, locked_until: null }).where('id', '=', user.id).execute();
    const orgs = await memberships(trx, user.id);
    if (orgs.length === 0) throw Errors.forbidden('所属している有効な法人がありません', 'NO_MEMBERSHIP');
    let membership = organizationId ? orgs.find((o) => o.organization_id === organizationId) : orgs.length === 1 ? orgs[0] : undefined;
    if (organizationId && !membership) throw Errors.forbidden('指定した法人に所属していません', 'NO_MEMBERSHIP');
    if (!membership) {
      return {
        status: 'organization_required' as const,
        organizations: orgs.map((o) => ({ id: o.organization_id, name: o.organization_name, slug: o.organization_slug })),
      };
    }
    if (user.mfa_enabled) {
      const code = otpCode();
      const challenge = await trx
        .insertInto('otp_challenges')
        .values({
          organization_id: membership.organization_id,
          user_id: user.id,
          purpose: 'staff_mfa',
          channel: 'email',
          destination: user.email,
          code_hash: hashToken(code),
          expires_at: new Date(Date.now() + OTP_TTL_MIN * 60_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await sendEmail({ to: user.email, subject: '【Salon OS】ログイン確認コード', text: `確認コード: ${code}\n有効期限: ${OTP_TTL_MIN}分` });
      return {
        status: 'mfa_required' as const,
        challengeId: challenge.id,
        channel: 'email' as const,
        destination: maskEmail(user.email),
        ...(config.DEV_EXPOSE_OTP ? { devCode: code } : {}),
      };
    }
    await trx.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute();
    membership = membership!;
    return { status: 'authenticated' as const, ...(await issueTokens(trx, user.id, membership.organization_id, membership.staff_id, meta)) };
  });
}

function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local!.slice(0, 2)}***@${domain}`;
}

export async function verifyOtp(challengeId: string, code: string, meta: LoginMeta): Promise<TokenPair> {
  return withSystem(async (trx) => {
    const ch = await trx.selectFrom('otp_challenges').selectAll().where('id', '=', challengeId).forUpdate().executeTakeFirst();
    const invalid = Errors.unauthenticated('確認コードが正しくないか、有効期限が切れています', 'INVALID_OTP');
    if (!ch || ch.purpose !== 'staff_mfa' || !ch.user_id || !ch.organization_id) throw invalid;
    if (ch.consumed_at || ch.expires_at < new Date() || ch.attempts >= ch.max_attempts) throw invalid;
    if (hashToken(code) !== ch.code_hash) {
      // attempt counter is incremented after rollback (see catch below)
      throw Object.assign(invalid, { commit: true });
    }
    await trx.updateTable('otp_challenges').set({ consumed_at: new Date() }).where('id', '=', ch.id).execute();
    const membership = (await memberships(trx, ch.user_id)).find((m) => m.organization_id === ch.organization_id);
    if (!membership) throw Errors.forbidden('所属している有効な法人がありません', 'NO_MEMBERSHIP');
    await trx.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', ch.user_id).execute();
    return issueTokens(trx, ch.user_id, membership.organization_id, membership.staff_id, meta);
  }).catch(async (err) => {
    // failed attempt counter must survive the rollback
    if ((err as { commit?: boolean }).commit) {
      await withSystem((trx) =>
        trx.updateTable('otp_challenges').set((eb) => ({ attempts: eb('attempts', '+', 1) })).where('id', '=', challengeId).execute(),
      );
    }
    throw err;
  });
}

/** Refresh-token rotation with reuse detection (a replayed rotated token revokes the whole family) */
export async function refresh(refreshToken: string, meta: LoginMeta): Promise<TokenPair> {
  const result = await withSystem(async (trx) => {
    const session = await trx
      .selectFrom('auth_sessions')
      .selectAll()
      .where('refresh_token_hash', '=', hashToken(refreshToken))
      .forUpdate()
      .executeTakeFirst();
    if (!session) return { error: 'invalid' as const };
    if (session.revoked_at) {
      await trx.updateTable('auth_sessions').set({ revoked_at: new Date() }).where('user_id', '=', session.user_id).where('revoked_at', 'is', null).execute();
      return { error: 'reused' as const };
    }
    if (session.expires_at < new Date()) return { error: 'invalid' as const };
    const membership = (await memberships(trx, session.user_id)).find((m) => m.organization_id === session.organization_id);
    if (!membership) return { error: 'invalid' as const };
    await trx.updateTable('auth_sessions').set({ revoked_at: new Date(), last_used_at: new Date() }).where('id', '=', session.id).execute();
    return { tokens: await issueTokens(trx, session.user_id, session.organization_id, membership.staff_id, meta, session.id) };
  });
  if ('error' in result) {
    throw Errors.unauthenticated(
      result.error === 'reused' ? 'セッションが無効化されました。再度ログインしてください' : 'セッションの有効期限が切れました',
      result.error === 'reused' ? 'REFRESH_TOKEN_REUSED' : 'INVALID_REFRESH_TOKEN',
    );
  }
  return result.tokens!;
}

export async function logout(refreshToken: string): Promise<void> {
  await withSystem((trx) =>
    trx.updateTable('auth_sessions').set({ revoked_at: new Date() }).where('refresh_token_hash', '=', hashToken(refreshToken)).where('revoked_at', 'is', null).execute(),
  );
}

export async function switchOrganization(userId: string, organizationId: string, meta: LoginMeta): Promise<TokenPair> {
  return withSystem(async (trx) => {
    const membership = (await memberships(trx, userId)).find((m) => m.organization_id === organizationId);
    if (!membership) throw Errors.forbidden('指定した法人に所属していません', 'NO_MEMBERSHIP');
    return issueTokens(trx, userId, organizationId, membership.staff_id, meta);
  });
}

export async function acceptInvite(token: string, password: string, meta: LoginMeta): Promise<TokenPair> {
  const payload = verifySignedPayload<{ typ: string; uid: string; org: string; stf: string }>(token);
  if (!payload || payload.typ !== 'invite') throw Errors.unauthenticated('招待リンクが無効か期限切れです', 'INVALID_INVITE');
  return withSystem(async (trx) => {
    const staff = await trx.selectFrom('staffs').select(['id', 'status', 'user_id']).where('id', '=', payload.stf).forUpdate().executeTakeFirst();
    // single use: once accepted (status active) the link can no longer be used as a login
    if (!staff || staff.user_id !== payload.uid || staff.status !== 'invited') {
      throw Errors.unauthenticated('招待リンクが無効か、既に使用されています', 'INVALID_INVITE');
    }
    const user = await trx.selectFrom('users').select(['id', 'password_hash']).where('id', '=', payload.uid).executeTakeFirstOrThrow();
    if (!user.password_hash) {
      await trx.updateTable('users').set({ password_hash: await hashPassword(password) }).where('id', '=', user.id).execute();
    } else if (!(await verifyPassword(password, user.password_hash))) {
      // existing account invited to another organization: must prove ownership with its current password
      throw Errors.unauthenticated('既存アカウントのパスワードを入力してください', 'INVALID_CREDENTIALS');
    }
    await trx.updateTable('staffs').set({ status: 'active' }).where('id', '=', staff.id).execute();
    invalidateActorCache(staff.id);
    return issueTokens(trx, user.id, payload.org, staff.id, meta);
  });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  await withSystem(async (trx) => {
    const user = await trx.selectFrom('users').select(['id', 'password_hash']).where('id', '=', userId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw Errors.unauthenticated('現在のパスワードが正しくありません', 'INVALID_CREDENTIALS');
    }
    await trx.updateTable('users').set({ password_hash: await hashPassword(newPassword) }).where('id', '=', userId).execute();
    // revoke other sessions
    await trx.updateTable('auth_sessions').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
  });
}

export async function setMfa(userId: string, enabled: boolean) {
  await withSystem((trx) => trx.updateTable('users').set({ mfa_enabled: enabled }).where('id', '=', userId).execute());
}

export async function me(userId: string, organizationId: string, staffId: string) {
  return withSystem(async (trx) => {
    const user = await trx.selectFrom('users').select(['id', 'email', 'display_name', 'mfa_enabled', 'last_login_at']).where('id', '=', userId).executeTakeFirstOrThrow();
    const orgs = await memberships(trx, userId);
    const org = await trx.selectFrom('organizations').select(['id', 'name', 'slug', 'plan', 'status', 'timezone', 'currency']).where('id', '=', organizationId).executeTakeFirstOrThrow();
    const staff = await trx
      .selectFrom('staffs')
      .innerJoin('roles', 'roles.id', 'staffs.role_id')
      .select(['staffs.id', 'staffs.display_name', 'staffs.color', 'staffs.title', 'roles.id as role_id', 'roles.key as role_key', 'roles.name as role_name'])
      .where('staffs.id', '=', staffId)
      .executeTakeFirstOrThrow();
    return { user, organization: org, staff, organizations: orgs.map((o) => ({ id: o.organization_id, name: o.organization_name, slug: o.organization_slug })) };
  });
}
