'use server';
import { randomToken } from '@salonos/core/crypto';
import { prisma } from '@/lib/server/db';
import { requireStaff, type StaffContext } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { readConfig, writeConfig, type IntegrationConfig } from '@/lib/server/integrations';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';
import { bool } from '../_components/guard';
import type { Reveal } from '../_components/client';
import { PROVIDER_BY_KEY } from './providers';

async function load(ctx: StaffContext, id: string) {
  const it = await prisma.integration.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!it) throw new AppError('連携設定が見つかりません');
  const def = PROVIDER_BY_KEY[it.provider];
  if (!def) throw new AppError('未対応の連携です');
  return { it, def, config: readConfig(it.configEnc) };
}

export async function createIntegrationAction(_: ActionResult<Reveal> | null, fd: FormData): Promise<ActionResult<Reveal>> {
  return runAction<Reveal>(async () => {
    const ctx = await requireStaff('settings.integrations');
    const def = PROVIDER_BY_KEY[String(fd.get('provider') ?? '')];
    if (!def) throw new AppError('連携先を選択してください');
    const scope = String(fd.get('scope') ?? '');
    let shopId: string | null = null;
    if (scope && scope !== 'org') {
      if (!def.perShop) throw new AppError('この連携は店舗ごとに設定できません');
      const shop = await prisma.shop.findFirst({ where: { id: scope, organizationId: ctx.org.id } });
      if (!shop) throw new AppError('店舗が見つかりません');
      shopId = shop.id;
    }
    if (!def.multiple) {
      const dup = await prisma.integration.findFirst({ where: { organizationId: ctx.org.id, provider: def.provider, shopId } });
      if (dup) throw new AppError('同じ範囲の連携が既にあります。既存の設定を編集してください。');
    }
    const config: IntegrationConfig = {};
    let secret: string | null = null;
    if (def.group === 'booking') { secret = `whsec_${randomToken(24)}`; config.webhookSecret = secret; }
    const it = await prisma.integration.create({ data: { organizationId: ctx.org.id, shopId, provider: def.provider, status: def.group === 'booking' ? 'ACTIVE' : 'PAUSED', configEnc: writeConfig(config) } });
    await audit(ctx, 'integration.updated', 'Integration', it.id, { op: 'created', provider: def.provider, shopId });
    if (secret) return { ok: true, data: { reveal: secret, revealLabel: `${def.label} の連携を作成しました。Webhook署名シークレット：`, revealNote: 'このシークレットは再表示できません。送信側（中継ツール等）に設定してください。紛失した場合は再生成できます。' } };
    return { ok: true, message: `${def.label} の連携を追加しました。認証情報を入力して「有効」にしてください。` };
  });
}

export async function updateIntegrationAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const { it, def, config } = await load(ctx, String(fd.get('id') ?? ''));
    const next: IntegrationConfig = { ...config };
    const changed: string[] = [];
    const fieldErrors: Record<string, string> = {};
    const [members, shops] = await Promise.all([
      prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true } }),
      prisma.shop.findMany({ where: { organizationId: ctx.org.id }, select: { id: true } }),
    ]);
    const userIds = new Set(members.map((m) => m.userId)), shopIds = new Set(shops.map((s) => s.id));
    for (const f of def.fields) {
      const raw = String(fd.get(f.key) ?? '').trim();
      if (f.secret) {
        if (bool(fd, `clear_${f.key}`)) { if (next[f.key]) { delete next[f.key]; changed.push(f.key); } continue; }
        if (raw) { if (raw.length > 4000) { fieldErrors[f.key] = '長すぎます'; continue; } if (raw !== next[f.key]) { next[f.key] = raw; changed.push(f.key); } }
        continue;
      }
      if (f.kind === 'json') {
        if (!raw) { if (next[f.key]) { delete next[f.key]; changed.push(f.key); } continue; }
        let obj: unknown;
        try { obj = JSON.parse(raw); } catch { fieldErrors[f.key] = `${f.label}：JSONの形式が正しくありません`; continue; }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Object.values(obj).every((v) => typeof v === 'string')) { fieldErrors[f.key] = `${f.label}：{ "外部ID": "ID" } の形式で入力してください`; continue; }
        const valid = f.key === 'staffMap' ? userIds : f.key === 'shopMap' ? shopIds : null;
        const bad = valid ? Object.values(obj as Record<string, string>).filter((v) => !valid.has(v)) : [];
        if (bad.length) { fieldErrors[f.key] = `${f.label}：組織に存在しないIDがあります（${bad.slice(0, 3).join(', ')}）`; continue; }
        if (JSON.stringify(obj) !== JSON.stringify(next[f.key])) { next[f.key] = obj; changed.push(f.key); }
        continue;
      }
      if (raw.length > 500) { fieldErrors[f.key] = '長すぎます'; continue; }
      if (f.kind === 'select' && raw && !f.options?.some((o) => o.value === raw)) { fieldErrors[f.key] = '選択肢から選んでください'; continue; }
      if ((next[f.key] ?? '') !== raw) { if (raw) next[f.key] = raw; else delete next[f.key]; changed.push(f.key); }
    }
    if (Object.keys(fieldErrors).length) return { ok: false, error: '入力内容を確認してください', fieldErrors };
    const status = fd.get('status') === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
    await prisma.integration.update({ where: { id: it.id }, data: { configEnc: writeConfig(next), status, ...(changed.length ? { lastError: null } : {}) } });
    await audit(ctx, 'integration.updated', 'Integration', it.id, { op: 'config', provider: it.provider, changedKeys: changed, status });
    return { ok: true, message: changed.length ? `保存しました（${changed.length}項目を更新）` : '保存しました' };
  });
}

export async function setIntegrationStatusAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const { it } = await load(ctx, String(fd.get('id') ?? ''));
    const status = fd.get('status') === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
    await prisma.integration.update({ where: { id: it.id }, data: { status } });
    await audit(ctx, 'integration.updated', 'Integration', it.id, { op: 'status', provider: it.provider, status });
  });
}

export async function deleteIntegrationAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const { it } = await load(ctx, String(fd.get('id') ?? ''));
    await prisma.integration.delete({ where: { id: it.id } });
    await audit(ctx, 'integration.updated', 'Integration', it.id, { op: 'deleted', provider: it.provider, shopId: it.shopId });
  });
}

export async function rotateWebhookSecretAction(_: ActionResult<Reveal> | null, fd: FormData): Promise<ActionResult<Reveal>> {
  return runAction<Reveal>(async () => {
    const ctx = await requireStaff('settings.integrations');
    const { it, def, config } = await load(ctx, String(fd.get('id') ?? ''));
    if (def.group !== 'booking') throw new AppError('この連携ではシークレットを生成できません');
    const secret = `whsec_${randomToken(24)}`;
    await prisma.integration.update({ where: { id: it.id }, data: { configEnc: writeConfig({ ...config, webhookSecret: secret }) } });
    await audit(ctx, 'integration.updated', 'Integration', it.id, { op: 'secret_rotated', provider: it.provider });
    return { ok: true, data: { reveal: secret, revealLabel: '新しいWebhook署名シークレット（以前のシークレットは無効になりました）：' } };
  });
}

async function probe(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; json: any; error?: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000), cache: 'no-store' });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (e: any) {
    return { ok: false, status: 0, json: null, error: e?.name === 'TimeoutError' ? 'タイムアウトしました' : `接続できませんでした（${e?.message ?? e}）` };
  }
}

export async function testIntegrationAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const { it, config } = await load(ctx, String(fd.get('id') ?? ''));
    let ok = false, message = '';
    if (it.provider === 'LINE') {
      if (!config.channelAccessToken) throw new AppError('チャネルアクセストークンが未設定です');
      const r = await probe('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${config.channelAccessToken}` } });
      ok = r.ok;
      message = r.ok ? `接続に成功しました：${r.json?.displayName ?? ''}（${r.json?.basicId ?? ''}）` : r.error ?? `LINE API がエラーを返しました（HTTP ${r.status}${r.json?.message ? `: ${r.json.message}` : ''}）`;
    } else if (it.provider === 'STRIPE') {
      if (!config.secretKey) throw new AppError('シークレットキーが未設定です');
      const r = await probe('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${config.secretKey}` } });
      ok = r.ok;
      message = r.ok ? `接続に成功しました（${r.json?.livemode ? '本番' : 'テスト'}モード）` : r.error ?? `Stripe がエラーを返しました（HTTP ${r.status}${r.json?.error?.message ? `: ${r.json.error.message}` : ''}）`;
    } else if (it.provider === 'SQUARE') {
      if (!config.accessToken) throw new AppError('アクセストークンが未設定です');
      const base = config.environment === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
      const r = await probe(`${base}/v2/locations`, { headers: { Authorization: `Bearer ${config.accessToken}`, 'Square-Version': '2024-06-04' } });
      ok = r.ok;
      const locs: any[] = r.json?.locations ?? [];
      message = r.ok ? `接続に成功しました（ロケーション ${locs.length}件${config.locationId && !locs.some((l) => l.id === config.locationId) ? '・指定のロケーションIDが見つかりません' : ''}）` : r.error ?? `Square がエラーを返しました（HTTP ${r.status}）`;
    } else {
      throw new AppError('この連携は接続テストに対応していません');
    }
    await prisma.integration.update({ where: { id: it.id }, data: { lastError: ok ? null : message.slice(0, 500) } });
    await audit(ctx, 'integration.tested', 'Integration', it.id, { provider: it.provider, ok });
    return ok ? { ok: true, message } : { ok: false, error: message };
  });
}
