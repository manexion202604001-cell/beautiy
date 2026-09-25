'use server';
import { AppError, type ActionResult } from '@/lib/server/errors';
import { CounselingValidationError, getCounselingByToken, submitCounseling } from '@/lib/server/karte';

// Public (no session): the unguessable single-use token is the capability.
export async function submitCounselingAction(token: string, _: ActionResult | null, fd: FormData): Promise<ActionResult> {
  try {
    const view = await getCounselingByToken(token);
    if (!view) return { ok: false, error: 'フォームが見つかりません。リンクをご確認ください。' };
    const answers: Record<string, unknown> = {};
    for (const f of view.form.fields) {
      const key = `f_${f.id}`;
      answers[f.id] = f.type === 'multiselect' ? fd.getAll(key).map(String) : f.type === 'checkbox' ? fd.get(key) === 'on' : String(fd.get(key) ?? '');
    }
    await submitCounseling(token, {
      answers, consent: fd.get('consent') === 'on',
      signatureData: String(fd.get('signatureData') ?? '') || null, signedName: String(fd.get('signedName') ?? '') || null,
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof CounselingValidationError) return { ok: false, error: '未入力または正しくない項目があります', fieldErrors: e.fieldErrors };
    if (e instanceof AppError) return { ok: false, error: e.message };
    console.error('[counseling.submit]', e);
    return { ok: false, error: '送信に失敗しました。通信環境をご確認のうえ、もう一度お試しください。' };
  }
}
