import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { orgApi, orgKeys, useRoles } from '../../../api/org';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Segmented,
  Select,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { EMPLOYMENT_LABEL, STAFF_COLORS as COLORS } from './shared';

/** API returns an absolute invite URL (WEB_BASE_URL); show it on the current origin */
function inviteLink(url: string) {
  try {
    const u = new URL(url);
    return `${window.location.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export function StaffCreateDialog({ onClose }: { onClose: () => void }) {
  const { shops, currentShopId, can } = useAuth();
  const roles = useRoles();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'invite' | 'password' | 'none'>('invite');
  const [f, setF] = useState({
    displayName: '',
    displayNameKana: '',
    email: '',
    initialPassword: '',
    roleId: '',
    shopIds: currentShopId ? [currentShopId] : [],
    title: '',
    color: COLORS[1]!,
    isBookable: true,
    nominationFee: '0',
    employmentType: 'full_time' as 'full_time' | 'part_time' | 'contractor' | 'owner',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [invite, setInvite] = useState<{ url: string; staffId: string } | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const roleOptions = (roles.data ?? []).filter((r) => r.key !== 'owner' || can('role.manage'));

  const save = async () => {
    const errs: Record<string, string> = {};
    if (!f.displayName.trim()) errs.displayName = '表示名を入力してください';
    if (!f.roleId) errs.roleId = '権限ロールを選択してください';
    if (mode !== 'none' && !/^\S+@\S+\.\S+$/.test(f.email))
      errs.email = 'メールアドレスを入力してください';
    if (mode === 'password' && f.initialPassword.length < 10)
      errs.initialPassword = '10文字以上で入力してください';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setError(null);
    try {
      const res = await orgApi.createStaff({
        displayName: f.displayName.trim(),
        displayNameKana: f.displayNameKana.trim() || undefined,
        email: mode === 'none' ? undefined : f.email.trim(),
        initialPassword: mode === 'password' ? f.initialPassword : undefined,
        roleId: f.roleId,
        shopIds: f.shopIds,
        title: f.title.trim() || undefined,
        color: f.color,
        isBookable: f.isBookable,
        nominationFee: Number(f.nominationFee) || 0,
        employmentType: f.employmentType,
      });
      void qc.invalidateQueries({ queryKey: orgKeys.staffAll });
      toast.success('スタッフを追加しました');
      if (res.inviteUrl) setInvite({ url: inviteLink(res.inviteUrl), staffId: res.staff.id });
      else {
        onClose();
        navigate(`/app/staff/${res.staff.id}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (invite) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="招待リンクを発行しました"
        description="このリンクをスタッフに送ってください。7日間有効です。リンクからパスワードを設定するとログインできます。"
        footer={
          <>
            <Button variant="ghost" onClick={() => navigate(`/app/staff/${invite.staffId}`)}>
              スタッフ詳細へ
            </Button>
            <Button
              variant="primary"
              icon="copy"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(invite.url)
                  .then(() => toast.success('リンクをコピーしました'));
              }}
            >
              リンクをコピー
            </Button>
          </>
        }
      >
        <label htmlFor="invite-url" className="sr-only">
          招待リンク
        </label>
        <Input
          id="invite-url"
          readOnly
          value={invite.url}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono text-xs"
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="スタッフを追加"
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            追加する
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="表示名" required error={errors.displayName}>
            <Input
              value={f.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              placeholder="山田 花子"
            />
          </Field>
          <Field label="フリガナ" optional>
            <Input
              value={f.displayNameKana}
              onChange={(e) => set('displayNameKana', e.target.value)}
            />
          </Field>
          <Field label="権限ロール" required error={errors.roleId}>
            <Select value={f.roleId} onChange={(e) => set('roleId', e.target.value)}>
              <option value="">選択してください</option>
              {roleOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.description ? ` — ${r.description}` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="雇用形態">
            <Select
              value={f.employmentType}
              onChange={(e) => set('employmentType', e.target.value as typeof f.employmentType)}
            >
              {Object.entries(EMPLOYMENT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="肩書き" optional>
            <Input
              value={f.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="スタイリスト"
            />
          </Field>
          <Field label="指名料">
            <Input
              type="number"
              min={0}
              step={10}
              value={f.nominationFee}
              onChange={(e) => set('nominationFee', e.target.value)}
              leading="¥"
            />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">ログイン</legend>
          <Segmented
            label="ログイン方法"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'invite', label: '招待メール（リンク）' },
              { value: 'password', label: '初期パスワードを設定' },
              { value: 'none', label: 'ログインなし' },
            ]}
          />
          {mode !== 'none' ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="メールアドレス" required error={errors.email}>
                <Input
                  type="email"
                  value={f.email}
                  onChange={(e) => set('email', e.target.value)}
                  autoComplete="off"
                />
              </Field>
              {mode === 'password' ? (
                <Field
                  label="初期パスワード"
                  required
                  error={errors.initialPassword}
                  hint="10文字以上"
                >
                  <Input
                    type="password"
                    value={f.initialPassword}
                    onChange={(e) => set('initialPassword', e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">
              カレンダーに表示するだけのスタッフ（業務委託など）向けです。
            </p>
          )}
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">所属店舗</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {shops.map((s) => (
              <Checkbox
                key={s.id}
                label={s.name}
                checked={f.shopIds.includes(s.id)}
                onChange={(e) =>
                  set(
                    'shopIds',
                    e.target.checked ? [...f.shopIds, s.id] : f.shopIds.filter((x) => x !== s.id),
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-2 text-[13px] font-semibold">予約</legend>
          <Checkbox
            label="予約を受け付ける（カレンダーに表示）"
            checked={f.isBookable}
            onChange={(e) => set('isBookable', e.target.checked)}
          />
          <div>
            <p className="mb-1.5 text-xs text-muted">カレンダーの色</p>
            <div className="flex gap-1.5" role="radiogroup" aria-label="カレンダーの色">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={f.color === c}
                  aria-label={c}
                  onClick={() => set('color', c)}
                  className={`h-8 w-8 rounded-full border-2 ${f.color === c ? 'border-fg' : 'border-transparent'}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
