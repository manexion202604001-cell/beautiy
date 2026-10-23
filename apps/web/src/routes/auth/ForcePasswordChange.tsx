import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { authApi } from '../../api/auth';
import { Button, Input, Label } from '../../components/shad';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT } from '../../lib/password';
import { AuthCard, AuthErrorBox } from './AuthCard';

/**
 * First login after 「ログイン情報を設定」: the temporary password the manager handed over must be
 * replaced before the app can be used (the API refuses everything else until then).
 */
export function ForcePasswordChange() {
  const { me, login, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const signOut = () => {
    void logout().then(() => navigate('/login'));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!current) return setError('仮パスワードを入力してください');
    if (password.length < PASSWORD_MIN_LENGTH) return setError(PASSWORD_TOO_SHORT);
    if (password !== confirm) return setError('パスワードが一致しません');
    if (password === current) return setError('仮パスワードとは別のパスワードを設定してください');
    setBusy(true);
    try {
      await authApi.changePassword(current, password);
      // the change signs every session out: sign in again with the new password
      const result = me
        ? await login(me.user.email, password, me.organization.id).catch(() => null)
        : null;
      if (result?.status !== 'authenticated') {
        await logout();
        navigate('/login', { replace: true });
      }
    } catch (err) {
      setError(errorMessage(err) || 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard description="新しいパスワードの設定">
      <form onSubmit={submit} className="sy-4" noValidate>
        {error ? <AuthErrorBox>{error}</AuthErrorBox> : null}
        <p className="text-sm text-muted-foreground">
          初回ログインのため、ご自身の新しいパスワードを設定してください。
        </p>
        <div className="sy-2">
          <Label htmlFor="currentPassword">仮パスワード</Label>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="sy-2">
          <Label htmlFor="password">新しいパスワード</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder={`${PASSWORD_MIN_LENGTH}文字以上`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
          />
        </div>
        <div className="sy-2">
          <Label htmlFor="confirmPassword">パスワード（確認）</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder="パスワードを再入力"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? '設定中...' : 'パスワードを設定'}
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={signOut}>
          ログアウト
        </Button>
      </form>
    </AuthCard>
  );
}
