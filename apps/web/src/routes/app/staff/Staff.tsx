import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Camera,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Mail,
  QrCode,
  Settings,
  SquarePen,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { IMAGE_ACCEPT, uploadFile } from '../../../api/files';
import { orgKeys, useRoles } from '../../../api/org';
import {
  staffScreenApi,
  useStaffDirectory,
  type StaffDirectoryRow,
} from '../../../api/staffScreen';
import {
  staffAdminApi,
  staffAdminKeys,
  useStaffInvitations,
  type InviteRoleKey,
} from '../../../api/storeSettings';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogTitle,
  Input,
  Label,
  Select,
} from '../../../components/shad';
import { Switch } from '../../../components/shad/switch';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cx } from '../../../lib/cn';
import { PASSWORD_MIN_LENGTH } from '../../../lib/password';
import { todayIn } from '../../../lib/time';
import { ReceptionQrDialog } from '../consents/ReceptionQrDialog';
import { StaffCodeInvite } from './StaffCodeInvite';
import { StaffSettingsDialog } from './StaffSettingsDialog';

/** Role names as this screen words them; other roles (受付・経理・カスタム) keep their own name */
const ROLE_LABEL: Record<string, string> = {
  owner: 'オーナー',
  manager: 'ディレクター',
  stylist: 'スタッフ',
};
const roleLabel = (role: StaffDirectoryRow['role']) =>
  role ? (ROLE_LABEL[role.key] ?? role.name) : '';

function RoleBadge({ role }: { role: StaffDirectoryRow['role'] }) {
  if (!role) return null;
  const variant =
    role.key === 'owner' ? 'default' : role.key === 'manager' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{roleLabel(role)}</Badge>;
}

const isRetired = (s: StaffDirectoryRow) => s.status === 'retired';
/** 有効 = may work and log in (an invitation that was not accepted yet counts as 有効) */
const isActive = (s: StaffDirectoryRow) => s.status !== 'inactive';
/** Status a staff member returns to when re-enabled / un-retired */
const activeStatus = (s: StaffDirectoryRow) => (s.user_id && !s.login_ready ? 'invited' : 'active');

const sortRetiredLast = (rows: StaffDirectoryRow[]) => [
  ...rows.filter((s) => !isRetired(s)),
  ...rows.filter(isRetired),
];

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(10);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

const EMPTY_FORM = {
  name: '',
  nickname: '',
  email: '',
  password: '',
  roleId: '',
  notifyLine: false,
  lineUserId: '',
  salonboardName: '',
  salonboardStaffId: '',
};

/** スタッフ管理: invitations, the shop's staff (order, photo, role, login, visibility, hours, reception QR) */
export default function Staff() {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { currentShop, currentShopId, timezone: tz, can } = useAuth();
  const shopId = currentShopId ?? '';
  const canManage = can('staff.manage');
  const canSchedule = canManage || can('schedule.manage');

  const directoryQ = useStaffDirectory(currentShopId);
  const rolesQ = useRoles();
  const invitationsQ = useStaffInvitations(canManage);
  const [list, setList] = useState<StaffDirectoryRow[]>([]);
  useEffect(() => {
    if (directoryQ.data) setList(sortRetiredLast(directoryQ.data));
  }, [directoryQ.data]);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: orgKeys.staffAll });
  };

  const formatDate = (value: string) =>
    new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T03:00:00Z` : value).toLocaleDateString(
      'ja-JP',
      {
        timeZone: tz,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short',
      },
    );

  // ---------------------------------------------------------------- スタッフ招待
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRoleKey>('stylist');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [invited, setInvited] = useState<{ name: string; url: string; emailSent: boolean } | null>(
    null,
  );
  const [inviteCopied, setInviteCopied] = useState(false);
  const [emailInviteOpen, setEmailInviteOpen] = useState(false);

  const sendInvite = async () => {
    if (!shopId || !inviteEmail.trim() || !inviteName.trim()) return;
    setInviting(true);
    setInviteError('');
    setInvited(null);
    setInviteCopied(false);
    try {
      const res = await staffAdminApi.invite({
        email: inviteEmail.trim(),
        displayName: inviteName.trim(),
        roleKey: inviteRole,
        shopId,
      });
      setInvited({ name: inviteName.trim(), url: res.inviteUrl, emailSent: res.emailSent });
      setInviteEmail('');
      setInviteName('');
      setInviteRole('stylist');
      void qc.invalidateQueries({ queryKey: staffAdminKeys.invitations });
      await refresh();
    } catch (e) {
      setInviteError(errorMessage(e) || '招待の送信に失敗しました');
    } finally {
      setInviting(false);
    }
  };
  const shopInvitations = (invitationsQ.data ?? []).filter((i) => i.shop_id === shopId);

  // ---------------------------------------------------------------- 並び替え
  const move = async (index: number, direction: 'up' | 'down') => {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= list.length || !shopId) return;
    const next = [...list];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setList(next);
    try {
      await staffScreenApi.reorder(
        shopId,
        next.map((s) => s.id),
      );
      await refresh();
    } catch (e) {
      toast.error('並び替えに失敗しました', errorMessage(e));
      await refresh();
    }
  };

  // ---------------------------------------------------------------- スタッフ編集
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<StaffDirectoryRow | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const openEdit = (s: StaffDirectoryRow) => {
    setEditing(s);
    setForm({
      name: s.display_name,
      nickname: s.nickname ?? '',
      email: s.login_email ?? s.email ?? '',
      password: '',
      roleId: s.role_id,
      notifyLine: s.notify_line,
      lineUserId: s.line_user_id ?? '',
      salonboardName: s.salonboard_name ?? '',
      salonboardStaffId: s.salonboard_staff_id ?? '',
    });
    setAvatarPreview(s.avatar_url ?? null);
    setAvatarFile(null);
    setEditOpen(true);
  };

  const roles = rolesQ.data ?? [];
  const roleOptions = (() => {
    const base = ['stylist', 'manager', 'owner']
      .map((key) => roles.find((r) => r.key === key))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ value: r.id, label: ROLE_LABEL[r.key]! }));
    const current = editing?.role;
    if (current && !base.some((o) => o.value === current.id))
      base.push({ value: current.id, label: current.name });
    return base;
  })();

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const email = form.email.trim();
      const hasLogin = !!editing.user_id;
      const patch: Record<string, unknown> = {};
      if (form.name.trim() && form.name.trim() !== editing.display_name)
        patch.displayName = form.name.trim();
      if (form.roleId && form.roleId !== editing.role_id) patch.roleId = form.roleId;
      if (form.salonboardName.trim() !== (editing.salonboard_name ?? ''))
        patch.salonboardName = form.salonboardName.trim() || null;
      if (form.salonboardStaffId.trim() !== (editing.salonboard_staff_id ?? ''))
        patch.salonboardStaffId = form.salonboardStaffId.trim() || null;
      // without a login the address is only a contact address until a password is set
      if (!hasLogin && !form.password && email && email !== (editing.email ?? ''))
        patch.email = email;
      if (Object.keys(patch).length) await staffScreenApi.update(editing.id, patch);

      let photoFileId: string | null | undefined;
      if (avatarFile) photoFileId = (await uploadFile(avatarFile, 'staff_photo')).id;
      else if (!avatarPreview && editing.avatar_url) photoFileId = null;
      await staffScreenApi.extras(editing.id, {
        nickname: form.nickname.trim() || null,
        notifyLine: form.notifyLine,
        lineUserId: form.lineUserId.trim() || null,
        ...(photoFileId !== undefined ? { photoFileId } : {}),
      });

      if (form.password || (hasLogin && email !== (editing.login_email ?? ''))) {
        if (!email) throw new Error('メールアドレスを入力してください');
        await staffScreenApi.credentials(editing.id, {
          email,
          ...(form.password ? { password: form.password } : {}),
        });
      }
      await refresh();
      setEditOpen(false);
    } catch (e) {
      toast.error('スタッフの保存に失敗しました', errorMessage(e));
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------- ログイン情報を設定
  const [credStaff, setCredStaff] = useState<StaffDirectoryRow | null>(null);
  const [credEmail, setCredEmail] = useState('');
  const [credPassword, setCredPassword] = useState('');
  const [credSaving, setCredSaving] = useState(false);
  const [credError, setCredError] = useState('');
  const [credDone, setCredDone] = useState(false);
  const [credCopied, setCredCopied] = useState(false);
  const loginUrl = `${window.location.origin}/login`;
  const credText = `【Salon OS スタッフアプリ ログイン情報】\nURL: ${loginUrl}\nメールアドレス: ${credEmail}\n仮パスワード: ${credPassword}\n\n※初回ログイン時に、ご自身の新しいパスワードの設定をお願いします。`;

  const openCredentials = (s: StaffDirectoryRow) => {
    setCredStaff(s);
    setCredEmail(s.login_email ?? s.email ?? '');
    setCredPassword(generatePassword());
    setCredError('');
    setCredDone(false);
    setCredCopied(false);
  };

  const saveCredentials = async () => {
    if (!credStaff) return;
    setCredError('');
    setCredSaving(true);
    try {
      await staffScreenApi.credentials(credStaff.id, {
        email: credEmail.trim(),
        password: credPassword,
        // the staff member must replace it at the first login
        temporary: true,
      });
      setCredDone(true);
      await refresh();
    } catch (e) {
      setCredError(errorMessage(e) || '設定に失敗しました');
    } finally {
      setCredSaving(false);
    }
  };

  // ---------------------------------------------------------------- row actions
  const toggleActive = async (s: StaffDirectoryRow) => {
    try {
      await staffScreenApi.update(s.id, { status: isActive(s) ? 'inactive' : activeStatus(s) });
      await refresh();
    } catch (e) {
      toast.error('スタッフの有効/無効の切り替えに失敗しました', errorMessage(e));
    }
  };

  const toggleVisibility = async (s: StaffDirectoryRow) => {
    if (!shopId) return;
    const visible = !s.is_visible_to_customer;
    try {
      await staffAdminApi.setVisibility(s.id, shopId, visible);
      setList((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, is_visible_to_customer: visible } : x)),
      );
      void refresh();
    } catch (e) {
      toast.error('表示設定の切り替えに失敗しました', errorMessage(e));
    }
  };

  const toggleRetired = async (s: StaffDirectoryRow) => {
    const retired = isRetired(s);
    const message = retired
      ? `${s.display_name}の退職を取り消しますか？\n再びログインできるようになります。`
      : `${s.display_name}を退職にしますか？\nお客様への表示がOFFになり、ログインもできなくなります。`;
    if (!window.confirm(message)) return;
    try {
      await staffScreenApi.update(
        s.id,
        retired
          ? { status: activeStatus(s), retiredOn: null }
          : { status: 'retired', retiredOn: todayIn(tz) },
      );
      await refresh();
      toast.success(
        retired
          ? `${s.display_name}の退職を取り消しました。`
          : `${s.display_name}を退職にしました（ログイン不可・お客様非表示）。`,
      );
    } catch (e) {
      toast.error('退職処理に失敗しました', errorMessage(e));
    }
  };

  const [settingsStaff, setSettingsStaff] = useState<StaffDirectoryRow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qrStaff, setQrStaff] = useState<StaffDirectoryRow | null>(null);

  if (directoryQ.isLoading || (!directoryQ.data && !directoryQ.isError)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }
  if (directoryQ.isError) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">
          スタッフを読み込めませんでした: {errorMessage(directoryQ.error)}
        </div>
      </div>
    );
  }

  const activeCount = list.filter((s) => !isRetired(s)).length;
  const retiredCount = list.length - activeCount;

  const iconButtons = (s: StaffDirectoryRow, mobile: boolean) => {
    const size = mobile ? 'h-8 w-8 p-0' : '';
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          className={size}
          onClick={() => navigate(`/app/customers/manage?staff_id=${s.id}`)}
          title="担当顧客"
          aria-label="担当顧客"
        >
          <Users className="h-4 w-4" />
        </Button>
        {canManage ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className={cx(size, isRetired(s) && 'text-destructive')}
              onClick={() => void toggleRetired(s)}
              title={isRetired(s) ? '退職取り消し' : '退職にする'}
              aria-label={isRetired(s) ? '退職取り消し' : '退職にする'}
            >
              <UserMinus className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={size}
              onClick={() => void toggleVisibility(s)}
              title={s.is_visible_to_customer ? 'お客様に表示中' : 'お客様に非表示'}
              aria-label={s.is_visible_to_customer ? 'お客様に表示中' : 'お客様に非表示'}
              aria-pressed={s.is_visible_to_customer}
            >
              {s.is_visible_to_customer ? (
                <Eye className="h-4 w-4 text-primary" />
              ) : (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={size}
              onClick={() => void toggleActive(s)}
              disabled={isRetired(s)}
              title={isActive(s) ? '無効にする' : '有効にする'}
              aria-label={isActive(s) ? '無効にする' : '有効にする'}
            >
              {isActive(s) ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
            </Button>
          </>
        ) : null}
        {canSchedule ? (
          <Button
            size="sm"
            variant="ghost"
            className={size}
            aria-label="営業時間・予約設定"
            onClick={() => {
              setSettingsStaff(s);
              setSettingsOpen(true);
            }}
          >
            <Settings className="h-4 w-4" />
          </Button>
        ) : null}
        {/* phones only, as the QR is shown to the customer at the counter */}
        {mobile ? (
          <Button
            size="sm"
            variant="ghost"
            className={size}
            title="受付QR"
            aria-label="受付QR"
            onClick={() => setQrStaff(s)}
          >
            <QrCode className="h-4 w-4" />
          </Button>
        ) : null}
        {canManage ? (
          <Button
            size="sm"
            variant="ghost"
            className={size}
            aria-label="スタッフ編集"
            onClick={() => openEdit(s)}
          >
            <SquarePen className="h-4 w-4" />
          </Button>
        ) : null}
      </>
    );
  };

  // dialogs sit outside the spaced column: its sibling margin would push a fixed panel down
  return (
    <>
      <div className="sy-4 md:sy-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold md:text-2xl">スタッフ管理</h1>
        </div>

        {/* スタッフ招待 */}
        {canManage ? (
          <Card>
            <CardHeader className="py-3 md:py-6">
              <CardTitle className="flex items-center gap-2 text-base md:text-lg">
                <UserPlus className="h-5 w-5" />
                スタッフ招待
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                スタッフの6桁IDを入力して、{currentShop?.name || 'この店舗'}に招待します
              </p>
            </CardHeader>
            <CardContent className="sy-4">
              <StaffCodeInvite
                shopId={currentShopId}
                shopName={currentShop?.name}
                onLinked={() =>
                  Promise.all([
                    qc.invalidateQueries({ queryKey: staffAdminKeys.invitations }),
                    refresh(),
                  ])
                }
                onUseEmail={() => setEmailInviteOpen(true)}
              />
              {/* Salon OS: people not registered yet (or registered at another salon) are invited by e-mail */}
              <div className="sy-4 border-t pt-4">
                <button
                  type="button"
                  className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
                  aria-expanded={emailInviteOpen}
                  onClick={() => setEmailInviteOpen((v) => !v)}
                >
                  <Mail className="h-4 w-4" />
                  メールアドレスで招待
                  {emailInviteOpen ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>
                {emailInviteOpen ? (
                  <>
                    {inviteError ? (
                      <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
                        {inviteError}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Input
                        type="email"
                        aria-label="招待するメールアドレス"
                        placeholder="メールアドレス"
                        value={inviteEmail}
                        onChange={(e) => {
                          setInviteEmail(e.target.value);
                          setInviteError('');
                        }}
                        className="max-w-[280px]"
                      />
                      <Input
                        aria-label="招待するスタッフの氏名"
                        placeholder="氏名"
                        value={inviteName}
                        onChange={(e) => {
                          setInviteName(e.target.value);
                          setInviteError('');
                        }}
                        className="max-w-[200px]"
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="sy-1">
                        <Label>権限</Label>
                        <Select
                          label="招待する権限"
                          className="w-[160px]"
                          value={inviteRole}
                          onValueChange={(v) => setInviteRole(v as InviteRoleKey)}
                          options={[
                            { value: 'stylist', label: 'スタッフ' },
                            { value: 'manager', label: 'ディレクター' },
                          ]}
                        />
                      </div>
                      <Button
                        onClick={() => void sendInvite()}
                        disabled={!inviteEmail.trim() || !inviteName.trim() || inviting}
                        className="mt-auto"
                      >
                        {inviting ? '送信中...' : '招待を送信'}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
              {invited ? (
                <div className="sy-3 rounded-lg border p-4" data-testid="invite-result">
                  <p className="text-sm">
                    {invited.emailSent
                      ? `${invited.name}さんに招待メールを送信しました。メール内のリンクからパスワードを設定すると参加できます（有効期限: 7日）。`
                      : `招待メールを送信できませんでした。下の招待リンクを${invited.name}さんに伝えてください（有効期限: 7日）。`}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-md bg-muted p-2 text-xs">
                      {invited.url}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(invited.url)
                          .then(() => setInviteCopied(true));
                      }}
                    >
                      {inviteCopied ? 'コピーしました ✓' : '招待リンクをコピー'}
                    </Button>
                  </div>
                </div>
              ) : null}
              {shopInvitations.length > 0 ? (
                <div className="sy-2 border-t pt-4">
                  <p className="text-sm font-medium text-muted-foreground">招待履歴</p>
                  {shopInvitations.slice(0, 5).map((inv) => (
                    <div key={inv.id} className="flex items-center gap-3 rounded-lg border p-3">
                      <Avatar name={inv.staff_name} className="h-8 w-8" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{inv.staff_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {inv.role_key === 'manager' ? 'ディレクター' : 'スタッフ'}
                          {inv.invited_by_name ? ` / ${inv.invited_by_name}が招待` : ''}
                        </p>
                      </div>
                      <Badge
                        variant={
                          inv.status === 'accepted'
                            ? 'default'
                            : inv.status === 'declined'
                              ? 'destructive'
                              : 'secondary'
                        }
                        className="shrink-0"
                      >
                        {inv.status === 'accepted'
                          ? '承認済'
                          : inv.status === 'declined'
                            ? '辞退'
                            : inv.status === 'cancelled'
                              ? '取消'
                              : '保留中'}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* スタッフ一覧 */}
        <Card>
          <CardHeader className="py-3 md:py-6">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base md:text-lg">
                スタッフ一覧
                <span className="ml-2 text-sm font-normal text-muted-foreground md:text-base">
                  (在籍{activeCount}名{retiredCount > 0 ? ` / 退職${retiredCount}名` : ''})
                </span>
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {list.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">スタッフがいません</div>
            ) : (
              <div className="sy-2 md:sy-3" data-testid="staff-list">
                {list.map((s, index) => {
                  const retired = isRetired(s);
                  const dateLine = retired
                    ? `退職: ${s.retired_on ? formatDate(s.retired_on) : '-'}`
                    : `登録: ${formatDate(s.created_at)}`;
                  const email = s.login_email ?? s.email ?? '';
                  const loginButtons = (mobile: boolean) =>
                    !s.login_ready && canManage && !retired ? (
                      <Button
                        size="sm"
                        variant="default"
                        className={mobile ? 'h-6 text-xs' : ''}
                        onClick={() => openCredentials(s)}
                      >
                        ログイン情報を設定
                      </Button>
                    ) : null;
                  return (
                    <div key={s.id} className="contents">
                      {retired && (index === 0 || !isRetired(list[index - 1]!)) ? (
                        <div className="flex items-center gap-3 pb-1 pt-4">
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-xs font-medium text-muted-foreground">
                            退職スタッフ
                          </span>
                          <div className="h-px flex-1 bg-border" />
                        </div>
                      ) : null}
                      <div
                        data-staff={s.id}
                        data-staff-name={s.display_name}
                        data-status={s.status}
                        data-login-ready={s.login_ready}
                        data-visible-to-customer={s.is_visible_to_customer}
                        data-nickname={s.nickname ?? ''}
                        className={cx(
                          'flex gap-2 rounded-lg border p-3 md:p-4',
                          (!isActive(s) || retired) && 'opacity-50',
                        )}
                      >
                        {canManage ? (
                          <div className="flex shrink-0 flex-col justify-center gap-0.5">
                            <button
                              type="button"
                              className="rounded-sm p-0.5 hover:bg-muted disabled:opacity-30"
                              disabled={index === 0}
                              aria-label="上へ"
                              onClick={() => void move(index, 'up')}
                            >
                              <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            </button>
                            <button
                              type="button"
                              className="rounded-sm p-0.5 hover:bg-muted disabled:opacity-30"
                              disabled={index === list.length - 1}
                              aria-label="下へ"
                              onClick={() => void move(index, 'down')}
                            >
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            </button>
                          </div>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          {/* mobile */}
                          <div className="md:hidden">
                            <div className="flex items-start gap-3">
                              <Avatar
                                name={s.display_name}
                                src={s.avatar_url}
                                className="h-10 w-10 shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-medium">{s.display_name}</span>
                                    {s.nickname ? (
                                      <span className="text-xs text-muted-foreground">
                                        ({s.nickname})
                                      </span>
                                    ) : null}
                                    {s.notify_line ? (
                                      <span title="LINE通知ON">
                                        <Bell className="h-3 w-3 text-green-500" />
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <RoleBadge role={s.role} />
                                    {!isActive(s) ? (
                                      <Badge
                                        variant="outline"
                                        className="text-xs text-muted-foreground"
                                      >
                                        無効
                                      </Badge>
                                    ) : null}
                                    {retired ? (
                                      <Badge variant="destructive" className="text-xs">
                                        退職
                                      </Badge>
                                    ) : null}
                                    {!s.login_ready && !retired ? (
                                      <Badge variant="destructive" className="text-xs">
                                        未認証
                                      </Badge>
                                    ) : null}
                                  </div>
                                </div>
                                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {email}
                                </div>
                                {s.customer_count > 0 ? (
                                  <div className="mt-0.5 flex flex-wrap gap-x-3">
                                    <span className="text-[10px] text-muted-foreground">
                                      顧客: {s.customer_count.toLocaleString()}人
                                    </span>
                                  </div>
                                ) : null}
                                {loginButtons(true) ? (
                                  <div className="mt-1 flex flex-wrap gap-1">
                                    {loginButtons(true)}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                            <div className="mt-3 sy-2 border-t pt-2">
                              <div className="text-xs text-muted-foreground">{dateLine}</div>
                              <div className="flex items-center gap-1">{iconButtons(s, true)}</div>
                            </div>
                          </div>
                          {/* desktop */}
                          <div className="hidden items-center justify-between md:flex">
                            <div className="flex items-center gap-4">
                              <Avatar name={s.display_name} src={s.avatar_url} />
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{s.display_name}</span>
                                  {s.nickname ? (
                                    <span className="text-sm text-muted-foreground">
                                      ({s.nickname})
                                    </span>
                                  ) : null}
                                  <RoleBadge role={s.role} />
                                  {s.notify_line ? (
                                    <span title="LINE通知ON">
                                      <Bell className="h-4 w-4 text-green-500" />
                                    </span>
                                  ) : null}
                                  {!isActive(s) ? (
                                    <Badge variant="outline" className="text-muted-foreground">
                                      無効
                                    </Badge>
                                  ) : null}
                                  {retired ? (
                                    <Badge variant="destructive">
                                      退職{s.retired_on ? ` ${formatDate(s.retired_on)}` : ''}
                                    </Badge>
                                  ) : null}
                                  {!s.login_ready && !retired ? (
                                    <Badge variant="destructive">未認証</Badge>
                                  ) : null}
                                  {!s.is_visible_to_customer && !retired ? (
                                    <Badge variant="outline">
                                      <EyeOff className="mr-1 h-3 w-3" />
                                      非表示
                                    </Badge>
                                  ) : null}
                                </div>
                                <div className="text-sm text-muted-foreground">
                                  {email}
                                  {s.customer_count > 0 ? (
                                    <span className="ml-3 text-xs">
                                      <span className="mr-3">
                                        顧客: {s.customer_count.toLocaleString()}人
                                      </span>
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-4">
                              {loginButtons(false) ? (
                                <div className="flex items-center gap-1">{loginButtons(false)}</div>
                              ) : null}
                              <div className="text-sm text-muted-foreground">{dateLine}</div>
                              <div className="flex items-center gap-2">{iconButtons(s, false)}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* スタッフ編集 */}
      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        className="max-h-[90vh] overflow-y-auto"
        title={
          <>
            <DialogTitle>スタッフ編集</DialogTitle>
            <p className="text-sm text-muted-foreground">スタッフ情報を入力してください</p>
          </>
        }
      >
        <div className="sy-4">
          <div className="sy-2">
            <Label>プロフィール写真</Label>
            <div className="flex items-center gap-4">
              <div className="relative">
                {avatarPreview ? (
                  <>
                    <Avatar
                      name={form.name || '?'}
                      src={avatarPreview}
                      className="h-20 w-20"
                      fallbackClassName="text-xl"
                    />
                    <Button
                      variant="destructive"
                      size="sm"
                      className="absolute -right-2 -top-2 h-6 w-6 rounded-full p-0"
                      aria-label="写真を削除"
                      onClick={() => {
                        setAvatarFile(null);
                        setAvatarPreview(null);
                        if (fileRef.current) fileRef.current.value = '';
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    className="flex h-20 w-20 flex-col gap-1 rounded-full"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Camera className="h-6 w-6" />
                    <span className="text-xs">追加</span>
                  </Button>
                )}
              </div>
              {avatarPreview ? (
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  変更
                </Button>
              ) : null}
              <input
                ref={fileRef}
                type="file"
                accept={IMAGE_ACCEPT}
                className="hidden"
                aria-label="プロフィール写真"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setAvatarFile(file);
                  const reader = new FileReader();
                  reader.onloadend = () => setAvatarPreview(reader.result as string);
                  reader.readAsDataURL(file);
                }}
              />
            </div>
          </div>
          <div className="sy-2">
            <Label htmlFor="staff-name">氏名</Label>
            <Input
              id="staff-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="staff-nickname">ニックネーム</Label>
            <Input
              id="staff-nickname"
              value={form.nickname}
              placeholder="表示名（お客様に表示される名前）"
              onChange={(e) => setForm({ ...form, nickname: e.target.value })}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="staff-email">メールアドレス</Label>
            <Input
              id="staff-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="sy-2">
            <Label htmlFor="staff-password">パスワード（変更する場合のみ）</Label>
            <Input
              id="staff-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <div className="sy-2">
            <Label>権限</Label>
            <Select
              label="権限"
              value={form.roleId}
              onValueChange={(roleId) => setForm({ ...form, roleId })}
              options={roleOptions}
            />
          </div>
          <div className="mt-4 border-t pt-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-green-500" />
                <Label id="staff-notify-line-label" className="font-medium">
                  LINE通知
                </Label>
              </div>
              <Switch
                aria-labelledby="staff-notify-line-label"
                checked={form.notifyLine}
                onCheckedChange={(notifyLine) => setForm({ ...form, notifyLine })}
              />
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              新規予約が入った時にLINEで通知を受け取ります
            </p>
            {form.notifyLine ? (
              <div className="sy-2">
                <Label htmlFor="staff-line-user-id">LINE User ID</Label>
                <Input
                  id="staff-line-user-id"
                  type="text"
                  placeholder="U1234567890abcdef..."
                  value={form.lineUserId}
                  onChange={(e) => setForm({ ...form, lineUserId: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  店舗のLINE公式アカウントと友だちになった際に取得できるUser IDを入力してください。
                  LINEで「ID確認」と送信すると、あなたのUser IDが表示されます。
                </p>
              </div>
            ) : null}
          </div>
          <div className="mt-4 border-t pt-4">
            <div className="sy-4">
              <div className="sy-2">
                <Label htmlFor="staff-salonboard-name" className="font-medium">
                  サロンボード スタッフ名
                </Label>
                <Input
                  id="staff-salonboard-name"
                  type="text"
                  placeholder="サロンボードに登録されている名前"
                  value={form.salonboardName}
                  onChange={(e) => setForm({ ...form, salonboardName: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  サロンボードに登録されている名前。CSV予約インポート時のスタッフマッチングに使用します
                </p>
              </div>
              <div className="sy-2">
                <Label htmlFor="staff-salonboard-staff-id" className="font-medium">
                  サロンボード スタッフID
                </Label>
                <Input
                  id="staff-salonboard-staff-id"
                  type="text"
                  placeholder="サロンボード上のスタッフID"
                  value={form.salonboardStaffId}
                  onChange={(e) => setForm({ ...form, salonboardStaffId: e.target.value })}
                />
                <p className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
                  …/KLP/reserve/…?
                  <span className="font-semibold text-foreground">staffId=W000123456</span>
                  &amp;…
                </p>
                <p className="text-xs text-muted-foreground">
                  サロンボードで新規予約を作成した時のURLに含まれる「staffId=」の後の番号を登録してください
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:sx-2">
          <Button variant="outline" onClick={() => setEditOpen(false)}>
            キャンセル
          </Button>
          <Button onClick={() => void saveEdit()} disabled={saving}>
            {saving ? '保存中...' : '更新'}
          </Button>
        </div>
      </Dialog>

      <StaffSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        staffMember={
          settingsStaff ? { id: settingsStaff.id, name: settingsStaff.display_name } : null
        }
        shopId={shopId}
      />

      <ReceptionQrDialog
        open={!!qrStaff}
        onOpenChange={(open) => {
          if (!open) setQrStaff(null);
        }}
        shopId={currentShopId}
        staffId={qrStaff?.id ?? null}
        staffName={qrStaff ? qrStaff.nickname || qrStaff.display_name : null}
      />

      {/* ログイン情報を設定 */}
      <Dialog
        open={!!credStaff}
        onOpenChange={(open) => {
          if (!open) setCredStaff(null);
        }}
        className="sm:max-w-md"
        title={
          <>
            <DialogTitle>
              ログイン情報を設定{credStaff ? `: ${credStaff.display_name}` : ''}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {credDone
                ? '設定が完了しました。下の内容をコピーしてスタッフにメールで送ってください。'
                : 'メールアドレスと仮パスワードを登録します。スタッフは初回ログイン時にパスワードの変更が必須になります。'}
            </p>
          </>
        }
      >
        {credDone ? (
          <div className="sy-4">
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
              {credText}
            </pre>
            <p className="text-xs text-muted-foreground">
              ※仮パスワードはこの画面を閉じると確認できなくなります。忘れた場合は再度「ログイン情報を設定」…はできないため、スタッフ編集からパスワードを設定し直してください。
            </p>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(credText).then(() => setCredCopied(true));
                }}
              >
                {credCopied ? 'コピーしました ✓' : 'URL・メール・パスワードを一式コピー'}
              </Button>
              <Button variant="outline" onClick={() => setCredStaff(null)}>
                閉じる
              </Button>
            </div>
          </div>
        ) : (
          <div className="sy-4">
            <div className="sy-2">
              <Label htmlFor="cred-email">メールアドレス</Label>
              <Input
                id="cred-email"
                type="email"
                placeholder="staff@example.com"
                value={credEmail}
                onChange={(e) => setCredEmail(e.target.value)}
                autoFocus
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="cred-password">仮パスワード</Label>
              <div className="flex gap-2">
                <Input
                  id="cred-password"
                  type="text"
                  value={credPassword}
                  onChange={(e) => setCredPassword(e.target.value)}
                  className="font-mono"
                />
                <Button variant="outline" onClick={() => setCredPassword(generatePassword())}>
                  再生成
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {PASSWORD_MIN_LENGTH}文字以上。自動生成されたものをそのまま使えます。
              </p>
            </div>
            {credError ? <p className="text-sm text-destructive">{credError}</p> : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCredStaff(null)}>
                キャンセル
              </Button>
              <Button
                onClick={() => void saveCredentials()}
                disabled={
                  credSaving || !credEmail.trim() || credPassword.length < PASSWORD_MIN_LENGTH
                }
              >
                {credSaving ? '設定中...' : '設定する'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
