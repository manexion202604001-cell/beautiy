import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { authApi } from '../../api/auth';
import { Button, Input, Label } from '../../components/shad';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT } from '../../lib/password';
import { AuthCard, AuthErrorBox } from './AuthCard';

/** Target of the staff invitation link: set a password and join the organization */
export default function Invite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { acceptTokens } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);

  const decline = async () => {
    if (!window.confirm('この招待を辞退しますか？')) return;
    setError('');
    setBusy(true);
    try {
      await authApi.declineInvite(token);
      setDeclined(true);
    } catch (err) {
      setError(errorMessage(err) || 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(PASSWORD_TOO_SHORT);
      return;
    }
    if (password !== confirm) {
      setError('パスワードが一致しません');
      return;
    }
    setBusy(true);
    try {
      const pair = await authApi.acceptInvite(token, password);
      qc.clear();
      acceptTokens(pair);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(errorMessage(err) || 'エラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  if (declined) {
    return (
      <AuthCard description="スタッフ招待">
        <p className="text-center text-sm text-muted-foreground">招待を辞退しました。</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard description="スタッフ招待">
      <form onSubmit={submit} className="sy-4" noValidate>
        {error ? <AuthErrorBox>{error}</AuthErrorBox> : null}
        <p className="text-sm text-muted-foreground">
          パスワードを設定して招待を受け付けます。設定後すぐにログインできます。
        </p>
        <div className="sy-2">
          <Label htmlFor="password">パスワード</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder={`${PASSWORD_MIN_LENGTH}文字以上`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoFocus
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
          {busy ? '設定中...' : '招待を受け付ける'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={() => void decline()}
        >
          辞退
        </Button>
        <p className="text-xs text-muted-foreground">
          ※
          既にアカウントをお持ちの場合は、そのアカウントの現在のパスワードを入力してください（パスワードは変更されません）。
        </p>
      </form>
    </AuthCard>
  );
}
