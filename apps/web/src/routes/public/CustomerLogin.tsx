import { useState } from 'react';
import { publicApi } from '../../api/public';
import type { CustomerAuthResult } from '../../api/types';
import { Alert, Button, Field, Icon, Input } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { customerSession } from '../../lib/session';
import { storageGet, storageSet } from '../../lib/storage';

interface LiffLike {
  isLoggedIn?: () => boolean;
  login?: () => void;
  getIDToken?: () => string | null;
}

/** LINE mock is enabled in dev or with VITE_LINE_MOCK=true (API LINE_DRIVER=mock accepts "mock:<userId>:<name>") */
export const LINE_MOCK = import.meta.env.DEV || import.meta.env.VITE_LINE_MOCK === 'true';

/** LIFF id token if running inside LINE (LIFF SDK loaded by the host page), mock token in dev */
export function getLineIdToken(displayName = 'LINEユーザー'): string | null {
  const liff = (window as unknown as { liff?: LiffLike }).liff;
  if (liff?.getIDToken) {
    if (liff.isLoggedIn && !liff.isLoggedIn()) {
      liff.login?.();
      return null;
    }
    return liff.getIDToken();
  }
  if (!LINE_MOCK) return null;
  let id = storageGet('salon.mockLineUserId');
  if (!id) {
    id = `U${Math.random().toString(16).slice(2, 12)}`;
    storageSet('salon.mockLineUserId', id);
  }
  return `mock:${id}:${displayName}`;
}

export function lineAvailable() {
  return LINE_MOCK || !!(window as unknown as { liff?: LiffLike }).liff;
}

/**
 * Customer login: LINE (LIFF) or phone/email one-time code.
 * On success stores the customer token for the shop slug.
 */
export function CustomerLogin({
  slug,
  onLoggedIn,
  compact,
}: {
  slug: string;
  onLoggedIn: (r: CustomerAuthResult & { via: 'line' | 'otp' }) => void;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<'choose' | 'otp-request' | 'otp-verify'>('choose');
  const [destination, setDestination] = useState('');
  const [challenge, setChallenge] = useState<{
    id: string;
    devCode?: string;
    channel: string;
  } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (r: CustomerAuthResult, via: 'line' | 'otp') => {
    customerSession.set({
      token: r.token,
      customerId: r.customerId,
      via,
      shopSlug: slug,
      savedAt: Date.now(),
    });
    onLoggedIn({ ...r, via });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const line = () =>
    run(async () => {
      const token = getLineIdToken();
      if (!token) throw new Error('LINEアプリから開いてください');
      done(await publicApi.loginLine(slug, token), 'line');
    });

  if (mode === 'otp-request' || mode === 'otp-verify') {
    return (
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {mode === 'otp-request' ? (
          <>
            <Field label="電話番号またはメールアドレス" hint="確認コードをお送りします">
              <Input
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                inputMode="email"
                autoComplete="tel"
                inputSize="lg"
                placeholder="090-1234-5678"
              />
            </Field>
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={busy}
              disabled={destination.trim().length < 5}
              onClick={() =>
                run(async () => {
                  const r = await publicApi.requestOtp(slug, destination.trim());
                  setChallenge({ id: r.challengeId, devCode: r.devCode, channel: r.channel });
                  setMode('otp-verify');
                })
              }
            >
              確認コードを送信
            </Button>
          </>
        ) : (
          <>
            <p className="text-[13px] text-muted">
              {challenge?.channel === 'email' ? 'メール' : 'SMS'}
              で届いた6桁のコードを入力してください。
            </p>
            {challenge?.devCode ? (
              <Alert tone="info" title="開発モード">
                確認コード: <span className="font-mono font-semibold">{challenge.devCode}</span>
              </Alert>
            ) : null}
            <Field label="確認コード">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                inputSize="lg"
                className="text-center font-mono text-xl tracking-[0.4em]"
              />
            </Field>
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={busy}
              disabled={code.length !== 6}
              onClick={() =>
                run(async () => done(await publicApi.verifyOtp(challenge!.id, code), 'otp'))
              }
            >
              ログイン
            </Button>
          </>
        )}
        <Button variant="ghost" className="w-full" onClick={() => setMode('choose')}>
          戻る
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {lineAvailable() ? (
        <button
          type="button"
          onClick={line}
          disabled={busy}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#06C755] text-[15px] font-semibold text-white shadow-sm hover:brightness-105 disabled:opacity-60"
        >
          <Icon name="line" size={20} />
          LINEでログイン
          {LINE_MOCK && !(window as unknown as { liff?: unknown }).liff ? '（開発用モック）' : ''}
        </button>
      ) : null}
      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        icon="phone"
        onClick={() => setMode('otp-request')}
      >
        電話番号・メールでログイン
      </Button>
      {!compact ? (
        <p className="pt-1 text-center text-xs text-muted">
          ログインすると、予約の確認・変更やお客様情報の入力を省略できます。
        </p>
      ) : null}
    </div>
  );
}
