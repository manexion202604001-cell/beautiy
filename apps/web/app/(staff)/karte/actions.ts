'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertShop, requireStaff } from '@/lib/server/session';
import { runAction, AppError, ForbiddenError, type ActionResult } from '@/lib/server/errors';
import { env } from '@/lib/server/env';
import { prisma } from '@/lib/server/db';
import { actorOf } from '@/lib/server/crm';
import {
  addKartePhotos, createKarte, deleteCounselingForm, deleteKarte, deleteKartePhoto, deleteKarteTemplate, formFieldSchema,
  issueCounselingLink, saveCounselingForm, saveKarteTemplate, sendKarteShare, setKarteShare, shopActorOf, updateKarte, updateKartePhoto,
} from '@/lib/server/karte';

const s = (fd: FormData, k: string) => { const v = fd.get(k); return typeof v === 'string' ? v : null; };

async function karteInShop(orgId: string, id: string) {
  const k = await prisma.karte.findFirst({ where: { id, organizationId: orgId }, select: { id: true, shopId: true, customerId: true } });
  if (!k) throw new AppError('カルテが見つかりません');
  return k;
}

export async function saveKarteAction(_: ActionResult<{ id: string }> | null, fd: FormData): Promise<ActionResult<{ id: string }>> {
  let createdId: string | null = null;
  const r = await runAction<{ id: string }>(async () => {
    const ctx = await requireStaff('karte.write');
    const id = s(fd, 'id');
    const fields = {
      treatmentNote: s(fd, 'treatmentNote'), formulaNote: s(fd, 'formulaNote'), assistantNote: s(fd, 'assistantNote'), careMemo: s(fd, 'careMemo'),
      visitDate: s(fd, 'visitDate') || null, sketchJson: s(fd, 'sketchJson'),
    };
    if (id) {
      const k = await karteInShop(ctx.org.id, id);
      assertShop(ctx, k.shopId);
      await updateKarte(actorOf(ctx), id, fields);
      revalidatePath(`/karte/${id}`);
      revalidatePath(`/customers/${k.customerId}`);
      return { ok: true, message: 'カルテを保存しました', data: { id } };
    }
    // shopActorOf: an appointment from a shop outside ctx.shops is rejected by the service.
    const res = await createKarte(shopActorOf(ctx), { ...fields, customerId: s(fd, 'customerId'), appointmentId: s(fd, 'appointmentId') || null, shopId: ctx.shop.id });
    createdId = res.id;
  });
  if (r.ok && createdId) redirect(`/karte/${createdId}?created=1`);
  return r;
}

export async function deleteKarteAction(fd: FormData) {
  let customerId = '';
  const r = await runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const k = await karteInShop(ctx.org.id, String(fd.get('id')));
    assertShop(ctx, k.shopId);
    customerId = await deleteKarte(actorOf(ctx), k.id);
  });
  if (r.ok) redirect(`/customers/${customerId}?tab=karte`);
  return r;
}

export async function uploadPhotoAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const k = await karteInShop(ctx.org.id, String(fd.get('karteId')));
    assertShop(ctx, k.shopId);
    const files = fd.getAll('photos').filter((f): f is File => typeof f !== 'string');
    const n = await addKartePhotos(actorOf(ctx), k.id, files, { kind: s(fd, 'kind') ?? 'AFTER', caption: s(fd, 'caption'), shareable: fd.get('shareable') === 'on' });
    revalidatePath(`/karte/${k.id}`);
    return { ok: true, message: `${n.length}枚の写真を追加しました` };
  });
}

export async function updatePhotoAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const karteId = await updateKartePhoto(shopActorOf(ctx), String(fd.get('photoId')), {
      shareable: fd.has('shareable') ? fd.get('shareable') === '1' : undefined,
      caption: fd.has('caption') ? s(fd, 'caption') : undefined,
      kind: s(fd, 'kind') ?? undefined,
    });
    revalidatePath(`/karte/${karteId}`);
  });
}

export async function deletePhotoAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const karteId = await deleteKartePhoto(shopActorOf(ctx), String(fd.get('photoId')));
    revalidatePath(`/karte/${karteId}`);
  });
}

export async function setShareAction(fd: FormData): Promise<ActionResult<{ url: string | null }>> {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const k = await karteInShop(ctx.org.id, String(fd.get('karteId')));
    assertShop(ctx, k.shopId);
    const mode = String(fd.get('mode'));
    const updated = await setKarteShare(shopActorOf(ctx), k.id, mode !== 'disable', { regenerate: mode === 'regenerate' });
    revalidatePath(`/karte/${k.id}`);
    return { ok: true, data: { url: updated.shareEnabled && updated.shareToken ? `${env.appUrl}/k/${updated.shareToken}` : null } };
  });
}

export async function sendShareAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    if (!ctx.can('message.send')) throw new ForbiddenError('メッセージ送信の権限がありません');
    const k = await karteInShop(ctx.org.id, String(fd.get('karteId')));
    assertShop(ctx, k.shopId);
    const channel = fd.get('channel') === 'EMAIL' ? 'EMAIL' : 'LINE';
    const msg = await sendKarteShare(shopActorOf(ctx), k.id, channel);
    revalidatePath(`/karte/${k.id}`);
    if (msg.status === 'SKIPPED') throw new AppError(`送信できませんでした: ${msg.error ?? '連絡先がありません'}`);
    if (msg.status === 'FAILED') throw new AppError(`送信に失敗しました: ${msg.error ?? ''}`);
    return { ok: true, message: `${channel === 'LINE' ? 'LINE' : 'メール'}で送信しました${msg.error === 'sandbox' ? '（サンドボックス）' : ''}` };
  });
}

// ── Templates ──

export async function saveTemplateAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const id = s(fd, 'id');
    await saveKarteTemplate(actorOf(ctx), id, { name: s(fd, 'name') ?? '', treatmentNote: s(fd, 'treatmentNote'), formulaNote: s(fd, 'formulaNote'), careMemo: s(fd, 'careMemo') });
    revalidatePath('/karte/templates');
    return { ok: true, message: id ? 'テンプレートを更新しました' : 'テンプレートを作成しました' };
  });
}

export async function deleteTemplateAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    await deleteKarteTemplate(actorOf(ctx), String(fd.get('id')));
    revalidatePath('/karte/templates');
  });
}

// ── Counseling forms ──

const formPayload = z.object({
  name: z.string(), description: z.string().nullable().optional(),
  fields: z.array(formFieldSchema.passthrough()), requireConsent: z.boolean(), consentText: z.string().nullable().optional(), active: z.boolean(),
});

export async function saveFormAction(_: ActionResult<{ id: string }> | null, fd: FormData): Promise<ActionResult<{ id: string }>> {
  let createdId: string | null = null;
  const r = await runAction<{ id: string }>(async () => {
    const ctx = await requireStaff('karte.write');
    let payload: unknown;
    try { payload = JSON.parse(String(fd.get('payload') ?? '')); } catch { throw new AppError('フォームの内容を読み取れませんでした'); }
    const p = formPayload.parse(payload);
    const id = s(fd, 'id');
    const f = await saveCounselingForm(actorOf(ctx), id, p);
    revalidatePath('/karte/forms');
    if (!id) { createdId = f.id; return; }
    revalidatePath(`/karte/forms/${id}`);
    return { ok: true, message: 'フォームを保存しました', data: { id: f.id } };
  });
  if (r.ok && createdId) redirect(`/karte/forms/${createdId}?created=1`);
  return r;
}

export async function deleteFormAction(fd: FormData) {
  let done = false;
  const r = await runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const res = await deleteCounselingForm(actorOf(ctx), String(fd.get('id')));
    revalidatePath('/karte/forms');
    done = res === 'deleted';
    if (!done) return { ok: true, message: '回答があるためフォームを非公開にしました（回答記録は保持されます）' };
  });
  if (r.ok && done) redirect('/karte/forms');
  return r;
}

export async function issueWalkInLinkAction(_: ActionResult<{ url: string }> | null, fd: FormData): Promise<ActionResult<{ url: string }>> {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const r = await issueCounselingLink(actorOf(ctx), { formId: String(fd.get('formId')) });
    revalidatePath(`/karte/forms/${r.formId}`);
    return { ok: true, data: { url: `${env.appUrl}/c/${r.token}` } };
  });
}
