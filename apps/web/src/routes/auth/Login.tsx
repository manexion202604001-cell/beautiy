import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import type { OrgRef } from '../../api/types';
import { ChevronRight } from 'lucide-react';
import { Button, Input, Label } from '../../components/shad';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthCard, AuthError } from './AuthCard';

type Step =
  | { kind: 'credentials' }
  | { kind: 'organization'; organizations: OrgRef[] }
  | { kind: 'mfa'; challengeId: string; destination: string; devCode?: string };

export default function Login() {
  const { login, verifyMfa, status } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const demo = Boolean(import.meta.env.VITE_DEMO);
  const [email, setEmail] = useState(demo ? 'owner@example.com' : '');
  const [password, setPassword] = useState(demo ? 'password-1234' : '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated')
    return <Navigate to={next && next.startsWith('/app') ? next : '/app'} replace />;

  const done = () => navigate(next && next.startsWith('/app') ? next : '/app', { replace: true });

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = (e: FormEvent, organizationId?: string) => {
    e.preventDefault();
    if (!email || !password) {
      setError('メールアドレスとパスワードを入力してください');
      return;
    }
    void run(async () => {
      const r = await login(email.trim(), password, organizationId);
      if (r.status === 'authenticated') done();
      else if (r.status === 'organization_required')
        setStep({ kind: 'organization', organizations: r.organizations });
      else
        setStep({
          kind: 'mfa',
          challengeId: r.challengeId,
          destination: r.destination,
          devCode: r.devCode,
        });
    });
  };

  const submitMfa = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'mfa') return;
    if (!/^\d{6}$/.test(code)) {
      setError('6桁の確認コードを入力してください');
      return;
    }
    void run(async () => {
      await verifyMfa(step.challengeId, code);
      done();
    });
  };

  if (step.kind === 'organization') {
    return (
      <AuthCard description="ログインする法人を選んでください">
        <div className="sy-4">
          {error ? <AuthError>{error}</AuthError> : null}
          <ul className="sy-2">
            {step.organizations.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => submitCredentials(e as unknown as FormEvent, o.id)}
                  className="flex w-full items-center justify-between rounded-lg border p-4 text-left transition-colors hover:bg-muted/50 disabled:opacity-50"
                >
                  <span>
                    <span className="block text-sm font-medium">{o.name}</span>
                    <span className="block text-xs text-muted-foreground">{o.slug}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
          <div className="text-center">
            <button
              type="button"
              className="text-sm text-muted-foreground hover:underline"
              onClick={() => setStep({ kind: 'credentials' })}
            >
              ログインに戻る
            </button>
          </div>
        </div>
      </AuthCard>
    );
  }

  if (step.kind === 'mfa') {
    return (
      <AuthCard description="確認コードを入力">
        <form onSubmit={submitMfa} className="sy-4" noValidate>
          <p className="text-sm text-muted-foreground">
            {step.destination} に6桁のコードを送信しました（10分間有効）。
          </p>
          {error ? <AuthError>{error}</AuthError> : null}
          {step.devCode ? (
            <p className="text-sm text-muted-foreground">
              開発モードの確認コード: <span className="font-mono font-semibold">{step.devCode}</span>
            </p>
          ) : null}
          <div className="sy-2">
            <Label htmlFor="code">確認コード</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            確認してログイン
          </Button>
          <div className="text-center">
            <button
              type="button"
              className="text-sm text-muted-foreground hover:underline"
              onClick={() => setStep({ kind: 'credentials' })}
            >
              ログインに戻る
            </button>
          </div>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard description="スタッフ用管理画面にログイン">
      <form onSubmit={(e) => submitCredentials(e)} className="sy-4" noValidate>
        <div className="sy-2">
          <Label htmlFor="email">メールアドレス または ログインID</Label>
          <Input
            id="email"
            type="text"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com または owner_xxxxx"
          />
        </div>
        <div className="sy-2">
          <Label htmlFor="password">パスワード</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error ? <AuthError>{error}</AuthError> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          ログイン
        </Button>
        <div className="text-center">
          <Link to="/forgot-password" className="text-sm text-muted-foreground hover:underline">
            パスワードを忘れた方
          </Link>
        </div>
      </form>
    </AuthCard>
  );
}
