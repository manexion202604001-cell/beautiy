/**
 * Error taxonomy (要件 8.1): business / authentication / authorization / external / validation / system.
 * Every error response has the shape:
 *   { error: { code, category, message, details?, requestId } }
 */
export type ErrorCategory =
  | 'validation'
  | 'business'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'conflict'
  | 'external'
  | 'rate_limit'
  | 'system';

const STATUS: Record<ErrorCategory, number> = {
  validation: 400,
  business: 422,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  external: 502,
  rate_limit: 429,
  system: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly category: ErrorCategory,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status ?? STATUS[category];
  }
}

export const Errors = {
  validation: (message: string, details?: unknown) => new AppError('validation', 'VALIDATION_ERROR', message, details),
  business: (code: string, message: string, details?: unknown) => new AppError('business', code, message, details),
  unauthenticated: (message = '認証が必要です', code = 'UNAUTHENTICATED') =>
    new AppError('authentication', code, message),
  forbidden: (message = 'この操作を行う権限がありません', code = 'FORBIDDEN', details?: unknown) =>
    new AppError('authorization', code, message, details),
  notFound: (resource: string, id?: string) =>
    new AppError('not_found', 'NOT_FOUND', `${resource}が見つかりません`, id ? { resource, id } : { resource }),
  conflict: (code: string, message: string, details?: unknown) => new AppError('conflict', code, message, details),
  external: (provider: string, message: string, details?: unknown) =>
    new AppError('external', 'EXTERNAL_SERVICE_ERROR', message, { provider, ...(details as object) }),
  rateLimited: (message = 'リクエストが多すぎます') => new AppError('rate_limit', 'RATE_LIMITED', message),
  system: (message = 'システムエラーが発生しました') => new AppError('system', 'INTERNAL_ERROR', message),
};

/** Map well-known Postgres errors to AppErrors */
export function fromPgError(err: unknown): AppError | null {
  const e = err as { code?: string; constraint?: string; detail?: string };
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case '23P01': // exclusion_violation
      if (e.constraint?.includes('no_staff_overlap')) {
        return Errors.conflict('APPOINTMENT_OVERLAP', 'この時間帯は既に予約が入っています（スタッフ重複）', {
          constraint: e.constraint,
        });
      }
      if (e.constraint?.includes('resources_no_overlap')) {
        return Errors.conflict('RESOURCE_OVERLAP', 'この時間帯は設備/席が埋まっています', { constraint: e.constraint });
      }
      return Errors.conflict('EXCLUSION_VIOLATION', '他のデータと重複しています', { constraint: e.constraint });
    case '23505':
      return Errors.conflict('UNIQUE_VIOLATION', '既に存在するデータと重複しています', {
        constraint: e.constraint,
      });
    case '23503':
      return Errors.validation('参照先のデータが存在しません', { constraint: e.constraint });
    case '23514':
      return Errors.validation('値が制約に違反しています', { constraint: e.constraint });
    case '40001':
    case '40P01':
      return Errors.conflict('CONCURRENT_UPDATE', '同時更新が発生しました。再試行してください');
    case '22P02':
      return Errors.validation('不正な形式の値です');
    default:
      return null;
  }
}
