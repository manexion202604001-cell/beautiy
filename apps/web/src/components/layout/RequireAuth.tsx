import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../../lib/auth';
import { ForcePasswordChange } from '../../routes/auth/ForcePasswordChange';
import { Button, EmptyState } from '../ui';

/**
 * Development only: skip the login screen by signing in with an account from apps/web/.env.local
 * (VITE_DEV_AUTO_LOGIN_EMAIL / VITE_DEV_AUTO_LOGIN_PASSWORD). Never active in a production build.
 */
const DEV_AUTO_LOGIN =
  import.meta.env.DEV &&
  import.meta.env.VITE_DEV_AUTO_LOGIN_EMAIL &&
  import.meta.env.VITE_DEV_AUTO_LOGIN_PASSWORD
    ? {
        email: String(import.meta.env.VITE_DEV_AUTO_LOGIN_EMAIL),
        password: String(import.meta.env.VITE_DEV_AUTO_LOGIN_PASSWORD),
      }
    : null;

function useDevAutoLogin(anonymous: boolean) {
  const { login } = useAuth();
  const tried = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!DEV_AUTO_LOGIN || !anonymous || tried.current) return;
    tried.current = true;
    login(DEV_AUTO_LOGIN.email, DEV_AUTO_LOGIN.password)
      .then((r) => {
        if (r.status !== 'authenticated') setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [anonymous, login]);
  return !!DEV_AUTO_LOGIN && anonymous && !failed;
}

/** Shown while the session is checked (same wording as the original screen) */
function SessionLoading() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-muted-foreground">読み込み中...</div>
    </div>
  );
}

/** Staff route guard: redirects to /login (keeping the destination) */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, retrySession, me, meLoading } = useAuth();
  const location = useLocation();
  const autoLoggingIn = useDevAutoLogin(status === 'anonymous');
  // /me decides the default shop and whether a temporary password must be replaced first
  if (status === 'loading' || autoLoggingIn || (status === 'authenticated' && meLoading))
    return <SessionLoading />;
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
  if (me?.user.must_change_password) return <ForcePasswordChange />;
  return <>{children}</>;
}
