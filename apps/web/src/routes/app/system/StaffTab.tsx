import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Eye,
  EyeOff,
  Mail,
  UserPlus,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { orgApi, orgKeys, useRoles, useStaffList } from '../../../api/org';
import {
  staffAdminApi,
  staffAdminKeys,
  useStaffInvitations,
  type InviteRoleKey,
} from '../../../api/storeSettings';
import type { Staff } from '../../../api/types';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
} from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { StaffCodeInvite } from '../staff/StaffCodeInvite';
import { nextAssignment, sortShopsForAssignment, sortStaffByShop } from './shared';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Labels of the two roles an invitation can grant, used until the role list has loaded */
const ROLE_FALLBACK: Record<InviteRoleKey, string> = {
  stylist: 'スタッフ',
  manager: 'ディレクター',
};

type SearchResult = { kind: 'existing'; staff: Staff } | { kind: 'new'; email: string };

/** スタッフ管理: invite staff to the selected shop, assign staff to shops, invitation history */
export function StaffTab() {
  const { shops, currentShop, timezone } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const staffQ = useStaffList({});
  const invitationsQ = useStaffInvitations();
  const rolesQ = useRoles();
  const staff = useMemo(() => staffQ.data ?? [], [staffQ.data]);
  const invitations = invitationsQ.data ?? [];

  const roleLabel = (key: InviteRoleKey) =>
    rolesQ.data?.find((r) => r.key === key)?.name ?? ROLE_FALLBACK[key];

  // ---- スタッフ招待
  const [email, setEmail] = useState('');
  const [searching, setSearching] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRoleKey>('stylist');
  const [emailOpen, setEmailOpen] = useState(false);
  const [sent, setSent] = useState<{ email: string; emailSent: boolean; inviteUrl: string } | null>(
    null,
  );

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: orgKeys.staffAll }),
      qc.invalidateQueries({ queryKey: staffAdminKeys.invitations }),
    ]);

  const search = async () => {
    const value = email.trim();
    if (!EMAIL.test(value)) {
      setInviteError('スタッフのメールアドレスを入力してください');
      return;
    }
    setSearching(true);
    setInviteError('');
    setResult(null);
    setSent(null);
    try {
      // look the address up in the latest staff list of the organization
      const latest = await qc.fetchQuery({
        queryKey: orgKeys.staff({ includeInactive: true }),
        queryFn: () => orgApi.staff({ includeInactive: true }),
        staleTime: 0,
      });
      const found = latest.find((s) => s.email?.toLowerCase() === value.toLowerCase());
      setResult(found ? { kind: 'existing', staff: found } : { kind: 'new', email: value });
      setInviteName('');
    } catch (e) {
      setInviteError(errorMessage(e) || 'スタッフが見つかりません');
    } finally {
      setSearching(false);
    }
  };

  const invite = async () => {
    if (!currentShop || !result) return;
    setInviting(true);
    setInviteError('');
    try {
      if (result.kind === 'existing') {
        const { shopIds, primaryShopId } = nextAssignment(result.staff.shops, currentShop.id, true);
        await staffAdminApi.setShops(result.staff.id, shopIds, primaryShopId);
      } else {
        const res = await staffAdminApi.invite({
          email: result.email,
          displayName: inviteName.trim(),
          roleKey: inviteRole,
          shopId: currentShop.id,
        });
        setSent({ email: result.email, emailSent: res.emailSent, inviteUrl: res.inviteUrl });
      }
      setEmail('');
      setResult(null);
      setInviteRole('stylist');
      void refresh();
    } catch (e) {
      setInviteError(errorMessage(e) || '招待の送信に失敗しました');
    } finally {
      setInviting(false);
    }
  };

  // ---- 店舗割り当て
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [sortShopId, setSortShopId] = useState<string | null>(null);
  const columns = useMemo(() => sortShopsForAssignment(shops), [shops]);
  const rows = useMemo(() => sortStaffByShop(staff, sortShopId), [staff, sortShopId]);

  const toggleAssignment = async (member: Staff, shopId: string, assign: boolean) => {
    setBusyKey(`${member.id}-${shopId}`);
    try {
      const { shopIds, primaryShopId } = nextAssignment(member.shops, shopId, assign);
      await staffAdminApi.setShops(member.id, shopIds, primaryShopId);
      await qc.invalidateQueries({ queryKey: orgKeys.staffAll });
    } catch (e) {
      toast.error('店舗割り当ての更新に失敗しました', errorMessage(e));
    } finally {
      setBusyKey(null);
    }
  };

  const toggleVisibility = async (member: Staff, shopId: string, visible: boolean) => {
    setBusyKey(`vis-${member.id}-${shopId}`);
    try {
      await staffAdminApi.setVisibility(member.id, shopId, visible);
      await qc.invalidateQueries({ queryKey: orgKeys.staffAll });
    } catch (e) {
      toast.error('表示設定の更新に失敗しました', errorMessage(e));
    } finally {
      setBusyKey(null);
    }
  };

  const alreadyHere =
    result?.kind === 'existing' && result.staff.shops.some((s) => s.shop_id === currentShop?.id);
  const notWorking =
    result?.kind === 'existing' &&
    (result.staff.status === 'retired' || result.staff.status === 'inactive');

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            スタッフ招待
          </CardTitle>
          <CardDescription>スタッフの6桁IDを入力して、現在選択中の店舗に招待します</CardDescription>
        </CardHeader>
        <CardContent className="sy-4">
          <StaffCodeInvite
            shopId={currentShop?.id ?? null}
            shopName={currentShop?.name}
            onLinked={refresh}
            onUseEmail={() => setEmailOpen(true)}
          />
          {/* Salon OS: people not registered yet (or registered at another salon) are invited by e-mail */}
          <div className="sy-4 border-t pt-4">
            <button
              type="button"
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={emailOpen}
              onClick={() => setEmailOpen((v) => !v)}
            >
              <Mail className="h-4 w-4" />
              メールアドレスで招待
              {emailOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {emailOpen ? (
              <>
                {inviteError ? (
                  <div
                    role="alert"
                    className="rounded-md bg-destructive/15 p-3 text-sm text-destructive"
                  >
                    {inviteError}
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Input
                    type="email"
                    aria-label="スタッフのメールアドレス"
                    placeholder="スタッフのメールアドレス"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setResult(null);
                      setInviteError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && EMAIL.test(email.trim())) void search();
                    }}
                    className="max-w-[320px]"
                  />
                  <Button
                    onClick={() => void search()}
                    disabled={searching || !EMAIL.test(email.trim())}
                  >
                    {searching ? '検索中...' : '検索'}
                  </Button>
                </div>
                {result ? (
                  <div className="rounded-lg border p-4 sy-3" data-testid="invite-result">
                    {result.kind === 'existing' ? (
                      <>
                        <div className="flex items-center gap-3">
                          <Avatar name={result.staff.display_name} className="h-10 w-10" />
                          <div>
                            <p className="font-medium">{result.staff.display_name}</p>
                            <p className="text-sm text-muted-foreground">{result.staff.email}</p>
                          </div>
                        </div>
                        {notWorking ? (
                          <p className="text-sm text-destructive">
                            このスタッフは{result.staff.status === 'retired' ? '退職' : '休止'}
                            として登録されています。スタッフ画面で在籍に戻してから店舗を割り当ててください
                          </p>
                        ) : alreadyHere ? (
                          <p className="text-sm text-muted-foreground">
                            このスタッフは既に「{currentShop?.name}」に所属しています
                          </p>
                        ) : (
                          <div className="flex items-center gap-3">
                            <p className="text-sm text-muted-foreground">
                              登録済みのスタッフです（{result.staff.role?.name ?? ''}）
                            </p>
                            <Button
                              onClick={() => void invite()}
                              disabled={inviting}
                              className="mt-auto"
                            >
                              {inviting ? '追加中...' : 'この店舗に追加'}
                            </Button>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-3">
                          <Avatar name={inviteName.trim() || result.email} className="h-10 w-10" />
                          <div className="flex-1 sy-1">
                            <Label htmlFor="invite-name">お名前</Label>
                            <Input
                              id="invite-name"
                              value={inviteName}
                              onChange={(e) => setInviteName(e.target.value)}
                              placeholder="例: 山田 花子"
                              className="max-w-[320px]"
                            />
                            <p className="text-sm text-muted-foreground">{result.email}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="sy-1">
                            <Label>権限</Label>
                            <Select
                              label="権限"
                              className="w-[160px]"
                              value={inviteRole}
                              onValueChange={(v) => setInviteRole(v as InviteRoleKey)}
                              options={[
                                { value: 'stylist', label: roleLabel('stylist') },
                                { value: 'manager', label: roleLabel('manager') },
                              ]}
                            />
                          </div>
                          <Button
                            onClick={() => void invite()}
                            disabled={inviting || !inviteName.trim() || !currentShop}
                            className="mt-auto"
                          >
                            {inviting ? '送信中...' : '招待を送信'}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
                {sent ? (
                  <div className="rounded-lg border p-4 sy-2 text-sm" data-testid="invite-sent">
                    {sent.emailSent ? (
                      <p>{sent.email} に招待メールを送信しました。</p>
                    ) : (
                      <p className="text-destructive">
                        招待は登録しましたが、メールを送信できませんでした。下のリンクをご本人に伝えてください。
                      </p>
                    )}
                    <p className="text-muted-foreground">
                      招待リンク（7日間有効）。メールが届かない場合はこのリンクを伝えてください。
                    </p>
                    <Input
                      readOnly
                      aria-label="招待リンク"
                      value={sent.inviteUrl}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>店舗割り当て</CardTitle>
          <CardDescription>
            スタッフがどの店舗で働くかを設定します。目のアイコンでお客様への表示/非表示を切り替えられます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {staffQ.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
          ) : staffQ.isError ? (
            <div className="py-8 text-center text-destructive">{errorMessage(staffQ.error)}</div>
          ) : shops.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">店舗がありません</div>
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-20 bg-background">
                  <tr className="border-b">
                    <th className="sticky left-0 z-30 min-w-[140px] bg-background py-2 pr-4 text-left font-medium">
                      スタッフ
                    </th>
                    {columns.map((shop) => (
                      <th
                        key={shop.id}
                        className="whitespace-nowrap px-3 py-2 text-center font-medium"
                      >
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 transition-colors hover:text-primary"
                          onClick={() => setSortShopId((cur) => (cur === shop.id ? null : shop.id))}
                          title="この店舗の所属スタッフを上に表示"
                        >
                          {shop.name}
                          <ArrowUpDown
                            className={`h-3 w-3 ${sortShopId === shop.id ? 'text-primary' : 'text-muted-foreground/50'}`}
                          />
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((member) => (
                    <tr key={member.id} className="border-b last:border-0" data-testid="staff-row">
                      <td className="sticky left-0 z-10 bg-background py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <Avatar
                            name={member.display_name}
                            className="h-7 w-7"
                            fallbackClassName="text-xs"
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{member.display_name}</p>
                            {member.title ? (
                              <p className="truncate text-xs text-muted-foreground">
                                {member.title}
                              </p>
                            ) : null}
                            {member.staff_code ? (
                              <p className="text-xs text-muted-foreground">
                                ID: {member.staff_code}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      {columns.map((shop) => {
                        const assignment = member.shops.find((s) => s.shop_id === shop.id);
                        const assigned = !!assignment;
                        const visible = assignment?.is_visible_to_customer === true;
                        const busy =
                          busyKey === `${member.id}-${shop.id}` ||
                          busyKey === `vis-${member.id}-${shop.id}`;
                        return (
                          <td key={shop.id} className="px-3 py-2 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <span
                                className={
                                  busy
                                    ? 'pointer-events-none flex opacity-50'
                                    : 'flex cursor-pointer'
                                }
                              >
                                <Checkbox
                                  checked={assigned}
                                  onCheckedChange={(next) => {
                                    if (!busyKey) void toggleAssignment(member, shop.id, next);
                                  }}
                                />
                              </span>
                              {assigned ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!busyKey) void toggleVisibility(member, shop.id, !visible);
                                  }}
                                  className={`rounded-sm p-0.5 hover:bg-accent ${busy ? 'pointer-events-none opacity-50' : ''}`}
                                  title={visible ? 'お客様に表示中' : 'お客様に非表示'}
                                  aria-label={visible ? 'お客様に表示中' : 'お客様に非表示'}
                                >
                                  {visible ? (
                                    <Eye className="h-3.5 w-3.5 text-primary" />
                                  ) : (
                                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                                  )}
                                </button>
                              ) : null}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={columns.length + 1}
                        className="py-8 text-center text-muted-foreground"
                      >
                        スタッフがいません
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            招待履歴
          </CardTitle>
          <CardDescription>送信した招待の状況を確認できます</CardDescription>
        </CardHeader>
        <CardContent>
          {invitationsQ.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
          ) : invitationsQ.isError ? (
            <div className="py-8 text-center text-destructive">
              {errorMessage(invitationsQ.error)}
            </div>
          ) : invitations.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">招待履歴はありません</div>
          ) : (
            <div className="sy-3">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  data-testid="invitation-row"
                  className="flex items-center justify-between gap-2 rounded-lg border p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar
                      name={inv.staff_name}
                      className="h-8 w-8 shrink-0"
                      fallbackClassName="text-xs"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{inv.staff_name}</p>
                        {inv.staff_code ? (
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            ID: {inv.staff_code}
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {inv.shop_name} / {inv.role_key === 'manager' ? 'ディレクター' : 'スタッフ'}
                        {inv.invited_by_name ? ` / ${inv.invited_by_name}が招待` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(inv.created_at).toLocaleDateString('ja-JP', { timeZone: timezone })}
                    </span>
                    {inv.status === 'pending' ? (
                      <Badge
                        variant="outline"
                        className="flex items-center gap-1 border-yellow-300 bg-yellow-50 text-yellow-600"
                      >
                        <Clock className="h-3 w-3" />
                        承認待ち
                      </Badge>
                    ) : null}
                    {inv.status === 'accepted' ? (
                      <Badge
                        variant="outline"
                        className="flex items-center gap-1 border-green-300 bg-green-50 text-green-600"
                      >
                        <Check className="h-3 w-3" />
                        承認済み
                      </Badge>
                    ) : null}
                    {inv.status === 'declined' ? (
                      <Badge
                        variant="outline"
                        className="flex items-center gap-1 border-red-300 bg-red-50 text-red-600"
                      >
                        <X className="h-3 w-3" />
                        辞退
                      </Badge>
                    ) : null}
                    {inv.status === 'cancelled' ? (
                      <Badge
                        variant="outline"
                        className="flex items-center gap-1 text-muted-foreground"
                      >
                        <X className="h-3 w-3" />
                        取消
                      </Badge>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
