'use server';
import { z } from 'zod';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { runAction, type ActionResult } from '@/lib/server/errors';
import { forceApplySyncEvent, ignoreSyncEvent, linkSyncEventToAppointment, retrySyncEvent, SYNC_STATUS_LABEL } from '@/lib/server/sync';

const id = (fd: FormData) => z.string().min(1).max(64).parse(String(fd.get('id') ?? ''));

function outcomeMessage(r: { claimed: boolean; status?: string; error?: string; deferred?: boolean }) {
  if (r.deferred) return { ok: true as const, message: '同じ予約の古い通知を処理中のため、順番待ちに入れました。しばらくすると自動で処理されます。' };
  if (!r.claimed) return { ok: false as const, error: '他の処理が実行中です。少し待ってから再読み込みしてください。' };
  if (r.status === 'DONE') return { ok: true as const, message: '予約に反映しました' };
  return { ok: false as const, error: `${SYNC_STATUS_LABEL[r.status as keyof typeof SYNC_STATUS_LABEL] ?? r.status}：${r.error ?? ''}` };
}

export async function retrySyncAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const eventId = id(fd);
    const r = await retrySyncEvent(ctx.org.id, eventId);
    await audit(ctx, 'sync.retried', 'SyncEvent', eventId, { result: r.status ?? null });
    return outcomeMessage(r);
  });
}

export async function forceSyncAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const eventId = id(fd);
    const dropStaff = fd.get('dropStaff') === '1';
    const r = await forceApplySyncEvent(ctx.org.id, eventId, { dropStaff });
    await audit(ctx, 'sync.force_applied', 'SyncEvent', eventId, { dropStaff, result: r.status ?? null });
    return outcomeMessage(r);
  });
}

export async function linkSyncAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const eventId = id(fd);
    const appointmentId = z.string().min(1).max(64).parse(String(fd.get('appointmentId') ?? ''));
    await linkSyncEventToAppointment(ctx.org.id, eventId, appointmentId);
    await audit(ctx, 'sync.linked', 'SyncEvent', eventId, { appointmentId });
    return { ok: true, message: '既存の予約と紐付けました。以降の変更・キャンセル通知はこの予約に反映されます。' };
  });
}

export async function ignoreSyncAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.integrations');
    const eventId = id(fd);
    const note = z.string().trim().max(200).parse(String(fd.get('note') ?? ''));
    await ignoreSyncEvent(ctx.org.id, eventId, note);
    await audit(ctx, 'sync.ignored', 'SyncEvent', eventId, { note });
    return { ok: true, message: '対応済み（無視）にしました' };
  });
}
