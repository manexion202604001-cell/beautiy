import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { authApi } from '../../api/auth';
import { errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Dialog, Field, Input, Switch, useToast } from '../ui';

export function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
    }
  }, [open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 10) return setError('新しいパスワードは10文字以上で入力してください');
    if (next !== confirm) return setError('確認用パスワードが一致しません');
    setSaving(true);
    try {
      await authApi.changePassword(current, next);
      toast.success('パスワードを変更しました', '安全のため再度ログインしてください');
      onClose();
      await logout();
      navigate('/login');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="パスワード変更"
      description="変更すると他の端末のセッションはすべてログアウトされます。"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" type="submit" form="pw-form" loading={saving}>
            変更する
          </Button>
        </>
      }
    >
      <form id="pw-form" onSubmit={submit} className="space-y-4">
        <Field label="現在のパスワード" required>
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="新しいパスワード" hint="10文字以上" required>
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="新しいパスワード（確認）" required error={error}>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

export function MfaDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open && me) setEnabled(me.user.mfa_enabled);
  }, [open, me]);
  const save = async () => {
    setSaving(true);
    try {
      await authApi.setMfa(enabled);
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(enabled ? '二段階認証を有効にしました' : '二段階認証を無効にしました');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="二段階認証（メールOTP）"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            キャンセル
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <Switch
        checked={enabled}
        onChange={setEnabled}
        label="ログイン時に確認コードを要求する"
        description={`有効にすると、ログインのたびに ${me?.user.email ?? '登録メールアドレス'} へ6桁のコードを送信します。`}
      />
    </Dialog>
  );
}
