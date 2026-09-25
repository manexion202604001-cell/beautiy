import { decrypt, encrypt, blindIndex, otpCode, sha256 } from '@salonos/core/crypto';
import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from '@salonos/core';
import { prisma } from './db';
import { cryptoKeys, env } from './env';
import { audit } from './audit';
import { AppError } from './errors';
import type { StaffContext } from './session';

export const UNLOCK_MINUTES = 30;

export function encryptField(v: string | null | undefined): string | null {
  if (!v) return null;
  return encrypt(v, cryptoKeys().encKey);
}

export function decryptField(v: string | null | undefined): string | null {
  if (!v) return null;
  try { return decrypt(v, cryptoKeys().encKey); } catch { return null; }
}

export function phoneHash(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw);
  return n ? blindIndex(`phone:${n}`, cryptoKeys().hashKey) : null;
}

export function emailHash(raw: string | null | undefined): string | null {
  const n = normalizeEmail(raw);
  return n ? blindIndex(`email:${n}`, cryptoKeys().hashKey) : null;
}

/** Build the encrypted column set for customer contact fields. undefined = leave unchanged. */
export function piiColumns(input: { phone?: string | null; email?: string | null; address?: string | null }) {
  const out: Record<string, string | null> = {};
  if (input.phone !== undefined) {
    const n = normalizePhone(input.phone);
    out.phoneEnc = n ? encryptField(n) : input.phone ? encryptField(input.phone.trim()) : null;
    out.phoneHash = phoneHash(input.phone);
  }
  if (input.email !== undefined) {
    const n = normalizeEmail(input.email);
    out.emailEnc = n ? encryptField(n) : null;
    out.emailHash = emailHash(input.email);
  }
  if (input.address !== undefined) out.addressEnc = input.address ? encryptField(input.address.trim()) : null;
  return out;
}

export interface PiiAccess { canView: boolean; via: 'role' | 'unlock' | null; unlockExpiresAt: Date | null }

export async function piiAccess(ctx: StaffContext): Promise<PiiAccess> {
  if (!ctx.can('customer.read')) return { canView: false, via: null, unlockExpiresAt: null };
  if (ctx.piiByDefault) return { canView: true, via: 'role', unlockExpiresAt: null };
  const u = await prisma.piiUnlock.findFirst({
    where: { organizationId: ctx.org.id, userId: ctx.user.id, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
  });
  return u ? { canView: true, via: 'unlock', unlockExpiresAt: u.expiresAt } : { canView: false, via: null, unlockExpiresAt: null };
}

export interface CustomerContact { phone: string | null; email: string | null; address: string | null; masked: boolean }

/**
 * Returns decrypted contact info only when the caller may view PII; otherwise masked values.
 * Every unmasked read is audited.
 */
export async function readCustomerContact(
  ctx: StaffContext,
  c: { id: string; phoneEnc: string | null; emailEnc: string | null; addressEnc: string | null },
  purpose = 'view',
): Promise<CustomerContact> {
  const access = await piiAccess(ctx);
  const phone = decryptField(c.phoneEnc), email = decryptField(c.emailEnc), address = decryptField(c.addressEnc);
  if (!access.canView) return { phone: maskPhone(phone), email: maskEmail(email), address: address ? '（ロック中）' : null, masked: true };
  await audit(ctx, 'customer.pii.read', 'Customer', c.id, { purpose, via: access.via });
  return { phone, email, address, masked: false };
}

/** Masked contact for list views (no audit needed; no plaintext leaves the server). */
export function maskedContact(c: { phoneEnc: string | null; emailEnc: string | null }) {
  return { phone: maskPhone(decryptField(c.phoneEnc)), email: maskEmail(decryptField(c.emailEnc)) };
}

// ── OTP-gated temporary unlock ──

export async function requestPiiUnlockOtp(ctx: StaffContext): Promise<{ devCode?: string }> {
  const code = otpCode();
  await prisma.otpChallenge.create({
    data: { userId: ctx.user.id, purpose: 'pii-unlock', codeHash: sha256(`${ctx.user.id}:${code}`), expiresAt: new Date(Date.now() + 10 * 60000) },
  });
  // Deliver to the signed-in user's own address (Resend; sandbox without RESEND_API_KEY).
  // Loaded lazily: notify.ts imports this module.
  const { sendEmail } = await import('./notify');
  const sent = await sendEmail(
    ctx.user.email, '【MANEXION Salon】個人情報の閲覧確認コード',
    `個人情報の一時閲覧のための確認コードです。\n\n確認コード：${code}\n有効期限：10分\n\nお心当たりがない場合は、このメールを破棄し管理者へご連絡ください。`,
  );
  await audit(ctx, 'customer.pii.otp_requested', 'User', ctx.user.id, { delivered: sent.ok, sandbox: !!sent.sandbox });
  if (env.demoMode) {
    // Demo only: the code is shown on screen / in the server log. Never logged in production.
    console.info(`[otp] PII unlock code for ${ctx.user.email}: ${code}`);
    return { devCode: code };
  }
  if (!sent.ok) throw new AppError('確認コードのメール送信に失敗しました。時間をおいて再度お試しください。');
  if (sent.sandbox) throw new AppError('メール送信が設定されていないため確認コードを送信できません。管理者にお問い合わせください。');
  return {};
}

export async function verifyPiiUnlockOtp(ctx: StaffContext, code: string, reason: string) {
  const ch = await prisma.otpChallenge.findFirst({
    where: { userId: ctx.user.id, purpose: 'pii-unlock', consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!ch) throw new AppError('確認コードの有効期限が切れています。再発行してください。');
  if (ch.attempts >= 5) throw new AppError('試行回数の上限に達しました。再発行してください。');
  if (ch.codeHash !== sha256(`${ctx.user.id}:${code.trim()}`)) {
    await prisma.otpChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
    await audit(ctx, 'customer.pii.otp_failed', 'User', ctx.user.id);
    throw new AppError('確認コードが正しくありません');
  }
  await prisma.otpChallenge.update({ where: { id: ch.id }, data: { consumedAt: new Date() } });
  const expiresAt = new Date(Date.now() + UNLOCK_MINUTES * 60000);
  await prisma.piiUnlock.create({ data: { organizationId: ctx.org.id, userId: ctx.user.id, reason, expiresAt } });
  await audit(ctx, 'customer.pii.unlock', 'User', ctx.user.id, { reason, expiresAt: expiresAt.toISOString() });
  return expiresAt;
}
