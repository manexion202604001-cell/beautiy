import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../../lib/auth';
import { Button, EmptyState, PageSpinner } from '../ui';

/** Staff route guard: redirects to /login (keeping the destination) */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, retrySession } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageSpinner label="セッションを確認しています" />;
  if (status === 'unreachable') {
    return (
      <div className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <EmptyState
          className="w-full"
          icon="refresh"
          title="サーバーに接続できません"
          description="通信状況を確認してから再試行してください。ログイン状態は保持されています。"
          action={
            <Button variant="primary" icon="refresh" onClick={retrySession}>
              再試行
            </Button>
          }
        />
      </div>
    );
  }
  if (status === 'anonymous') {
    const next = location.pathname + location.search;
    return (
      <Navigate
        to={`/login${next && next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`}
        replace
      />
    );
  }
  return <>{children}</>;
}
