import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { authApi } from '../../api/auth';
import { Button, Input, Label } from '../../components/shad';
import { errorMessage } from '../../lib/api';
import { AuthCard, AuthError } from './AuthCard';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('メールアドレスを入力してください');
      return;
    }
    setError(null);
    setBusy(true);
    authApi
      .requestPasswordReset(email.trim())
      .then(() => setSent(true))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AuthCard description="パスワードリセット">
      <form onSubmit={submit} className="sy-4" noValidate>
        <p className="text-sm text-muted-foreground">
          {sent
            ? '入力したメールアドレスが登録されている場合、パスワードリセットのリンクを送信しました。メールをご確認ください。'
            : '登録したメールアドレスを入力してください。パスワードリセットのリンクを送信します。'}
        </p>
        {sent ? null : (
          <>
            <div className="sy-2">
              <Label htmlFor="email">メールアドレス</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
              />
            </div>
            {error ? <AuthError>{error}</AuthError> : null}
            <Button type="submit" className="w-full" disabled={busy}>
              リセットリンクを送信
            </Button>
          </>
        )}
        <div className="text-center">
          <Link to="/login" className="text-sm text-muted-foreground hover:underline">
            ログインに戻る
          </Link>
        </div>
      </form>
    </AuthCard>
  );
}
