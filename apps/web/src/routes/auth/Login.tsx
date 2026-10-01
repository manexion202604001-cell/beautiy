import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import type { OrgRef } from '../../api/types';
import { Alert, Button, Field, Icon, Input } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthShell } from './AuthShell';

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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      <AuthShell
        title="法人を選択"
        subtitle="複数の法人に所属しています。ログインする法人を選んでください。"
      >
        {error ? (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        ) : null}
        <ul className="space-y-2">
          {step.organizations.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                disabled={busy}
                onClick={(e) => submitCredentials(e as unknown as FormEvent, o.id)}
                className="flex w-full items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 text-left hover:border-primary hover:bg-primary-soft/40 disabled:opacity-60"
              >
                <span>
                  <span className="block text-sm font-medium text-fg">{o.name}</span>
                  <span className="block text-xs text-muted">{o.slug}</span>
                </span>
                <Icon name="chevron-right" className="text-muted" />
              </button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" className="mt-4" onClick={() => setStep({ kind: 'credentials' })}>
          戻る
        </Button>
      </AuthShell>
    );
  }

  if (step.kind === 'mfa') {
    return (
      <AuthShell
        title="確認コードを入力"
        subtitle={`${step.destination} に6桁のコードを送信しました（10分間有効）。`}
      >
        <form onSubmit={submitMfa} className="space-y-4" noValidate>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {step.devCode ? (
            <Alert tone="info" title="開発モード">
              確認コード: <span className="font-mono font-semibold tabular">{step.devCode}</span>
            </Alert>
          ) : null}
          <Field label="確認コード" required>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              inputSize="lg"
              className="text-center font-mono text-xl tracking-[0.5em]"
              autoFocus
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            確認してログイン
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => setStep({ kind: 'credentials' })}
          >
            戻る
          </Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="ログイン"
      subtitle="スタッフアカウントでログインしてください。"
      footer={
        <>
          はじめてご利用ですか？{' '}
          <Link to="/signup" className="font-medium text-primary hover:underline">
            新規法人登録
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => submitCredentials(e)} className="space-y-4" noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Field label="メールアドレス" required>
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputSize="lg"
            autoFocus
            placeholder="you@example.com"
          />
        </Field>
        <Field label="パスワード" required>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            inputSize="lg"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          ログイン
        </Button>
      </form>
      {import.meta.env.DEV ? (
        <p className="mt-6 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          開発用: <span className="font-mono">owner@example.com</span> /{' '}
          <span className="font-mono">password-1234</span>（
          <span className="font-mono">pnpm --filter @salon/api db:seed</span>）
        </p>
      ) : null}
    </AuthShell>
  );
}
