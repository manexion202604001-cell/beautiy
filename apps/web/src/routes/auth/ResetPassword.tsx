import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { authApi } from '../../api/auth';
import { Button, Input, Label, buttonVariants } from '../../components/shad';
import { errorMessage } from '../../lib/api';
import { AuthCard, AuthErrorBox } from './AuthCard';

/** Passwords are at least this long (API rule) */
const MIN_PASSWORD = 10;

/** Target of the emailed reset link: set a new password */
export default function ResetPassword() {
  const params = useParams();
  const [query] = useSearchParams();
  const token = params.token || query.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD) {
      setError(`パスワードは${MIN_PASSWORD}文字以上にしてください`);
      return;
    }
    if (password !== confirm) {
      setError('パスワードが一致しません');
      return;
    }
    setBusy(true);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err) || 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard description="新しいパスワードの設定">
      {!token ? (
        <div className="sy-4 text-center">
          <p className="text-sm text-destructive">無効なリンクです。</p>
          <Link to="/forgot-password" className={buttonVariants('outline', 'default', 'w-full')}>
            パスワードリセットを再申請
          </Link>
        </div>
      ) : done ? (
        <div className="sy-4 text-center">
          <p className="text-sm text-muted-foreground">
            パスワードを変更しました。新しいパスワードでログインしてください。
          </p>
          <Link to="/login" className={buttonVariants('default', 'default', 'w-full')}>
            ログインへ
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="sy-4" noValidate>
          {error ? <AuthErrorBox>{error}</AuthErrorBox> : null}
          <div className="sy-2">
            <Label htmlFor="password">新しいパスワード</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder={`${MIN_PASSWORD}文字以上`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="confirmPassword">パスワード（確認）</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={MIN_PASSWORD}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? '変更中...' : 'パスワードを変更'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
