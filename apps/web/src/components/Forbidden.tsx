import { ApiError } from '../lib/api';
import { ErrorState } from './ui';

/** Shown when the signed-in staff lacks the permission for a whole screen */
export function Forbidden({ permission }: { permission: string }) {
  return (
    <ErrorState
      error={
        new ApiError({
          status: 403,
          code: 'FORBIDDEN',
          category: 'authorization',
          message: `この画面には権限（${permission}）が必要です。管理者にお問い合わせください。`,
        })
      }
    />
  );
}
