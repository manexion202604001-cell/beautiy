export class AppError extends Error {
  constructor(message: string, public code: string = 'BAD_REQUEST', public status = 400) { super(message); }
}
export class ForbiddenError extends AppError {
  constructor(message = 'この操作を行う権限がありません') { super(message, 'FORBIDDEN', 403); }
}
export class NotFoundError extends AppError {
  constructor(message = '見つかりません') { super(message, 'NOT_FOUND', 404); }
}

export type ActionResult<T = undefined> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/** Wrap a server action body: converts thrown AppError/ZodError into ActionResult. */
export async function runAction<T>(fn: () => Promise<ActionResult<T> | void>): Promise<ActionResult<T>> {
  try {
    const r = await fn();
    return r ?? { ok: true };
  } catch (e: any) {
    if (e?.digest?.startsWith?.('NEXT_REDIRECT') || e?.message === 'NEXT_REDIRECT') throw e;
    if (e instanceof AppError) return { ok: false, error: e.message };
    if (e?.name === 'ZodError') {
      const fieldErrors: Record<string, string> = {};
      for (const i of e.issues ?? []) fieldErrors[i.path.join('.')] = i.message;
      return { ok: false, error: '入力内容を確認してください', fieldErrors };
    }
    console.error('[action]', e);
    return { ok: false, error: '処理に失敗しました。時間をおいて再度お試しください。' };
  }
}
