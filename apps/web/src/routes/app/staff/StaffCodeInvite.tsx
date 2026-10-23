import { useState } from 'react';
import { staffAdminApi, type InviteRoleKey, type StaffCodeMatch } from '../../../api/storeSettings';
import { Avatar, Button, Label, Input, Select } from '../../../components/shad';
import { errorMessage } from '../../../lib/api';

/** 権限 an invitation grants, worded as on the original screen */
export const INVITE_ROLE_OPTIONS: { value: InviteRoleKey; label: string }[] = [
  { value: 'stylist', label: 'スタッフ' },
  { value: 'manager', label: 'ディレクター' },
];

/**
 * スタッフ招待 by 6-digit staff ID (スタッフ screen and 設定 › スタッフ管理): search the ID, choose 権限,
 * 招待を送信. A staff member of another salon cannot be added by ID (staff records belong to one
 * salon); `onUseEmail` then offers the e-mail invitation instead.
 */
export function StaffCodeInvite({
  shopId,
  shopName,
  onLinked,
  onUseEmail,
}: {
  shopId: string | null;
  shopName?: string;
  onLinked: () => void | Promise<unknown>;
  onUseEmail?: () => void;
}) {
  const [code, setCode] = useState('');
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [found, setFound] = useState<StaffCodeMatch | null>(null);
  const [role, setRole] = useState<InviteRoleKey>('stylist');
  const [error, setError] = useState('');

  const search = async () => {
    if (code.length !== 6) return;
    setSearching(true);
    setError('');
    setFound(null);
    try {
      const { staff } = await staffAdminApi.searchByCode(code);
      setFound(staff);
      setRole(staff.same_organization && staff.role_key === 'manager' ? 'manager' : 'stylist');
    } catch (e) {
      setError(errorMessage(e) || 'スタッフが見つかりません');
    } finally {
      setSearching(false);
    }
  };

  const send = async () => {
    if (!found || !shopId) return;
    setSending(true);
    setError('');
    try {
      await staffAdminApi.linkByCode({ staffCode: found.staff_code, shopId, roleKey: role });
      setCode('');
      setFound(null);
      setRole('stylist');
      await onLinked();
    } catch (e) {
      setError(errorMessage(e) || '招待の送信に失敗しました');
    } finally {
      setSending(false);
    }
  };

  const here = found?.same_organization && !!shopId && found.shop_ids.includes(shopId);
  const notWorking =
    found?.same_organization && (found.status === 'retired' || found.status === 'inactive');
  const blocked = !found || !found.same_organization || here || notWorking;

  return (
    <div className="sy-4">
      {error ? (
        <div role="alert" className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          aria-label="6桁のスタッフID"
          placeholder="6桁のスタッフID"
          inputMode="numeric"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
            setFound(null);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
          maxLength={6}
          className="max-w-[200px] font-mono text-lg tracking-widest"
        />
        <Button onClick={() => void search()} disabled={searching || code.length !== 6}>
          {searching ? '検索中...' : '検索'}
        </Button>
      </div>
      {found ? (
        <div className="sy-3 rounded-lg border p-4" data-testid="staff-code-result">
          <div className="flex items-center gap-3">
            <Avatar name={found.name} src={found.avatar_url} className="h-10 w-10" />
            <div>
              <p className="font-medium">{found.name}</p>
              <p className="text-sm text-muted-foreground">ID: {found.staff_code}</p>
            </div>
          </div>
          {!found.same_organization ? (
            <div className="sy-2">
              <p className="text-sm text-destructive">
                このスタッフは別のサロンに登録されているため、IDでは招待できません。「メールアドレスで招待」から招待してください
              </p>
              {onUseEmail ? (
                <Button variant="outline" size="sm" onClick={onUseEmail}>
                  メールアドレスで招待
                </Button>
              ) : null}
            </div>
          ) : notWorking ? (
            <p className="text-sm text-destructive">
              このスタッフは{found.status === 'retired' ? '退職' : '無効'}
              として登録されています。スタッフ画面で在籍に戻してから招待してください
            </p>
          ) : here ? (
            <p className="text-sm text-muted-foreground">
              このスタッフは既に「{shopName || 'この店舗'}」に所属しています
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <div className="sy-1">
              <Label>権限</Label>
              <Select
                label="権限"
                className="w-[160px]"
                value={role}
                onValueChange={(v) => setRole(v as InviteRoleKey)}
                options={INVITE_ROLE_OPTIONS}
              />
            </div>
            <Button
              onClick={() => void send()}
              disabled={blocked || sending || !shopId}
              className="mt-auto"
            >
              {sending ? '送信中...' : '招待を送信'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
