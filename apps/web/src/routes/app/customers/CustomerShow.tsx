import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Briefcase,
  Calendar,
  ChevronRight,
  ClipboardList,
  FileText,
  Mail,
  MapPin,
  Phone,
  Plus,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { customerKeys, customersApi, useCustomer } from '../../../api/customers';
import { karteKeys, kartesApi, useKartes } from '../../../api/kartes';
import type { AppointmentStatus, CustomerDetail, CustomerInput } from '../../../api/types';
import { ReservationStatusBadge } from '../../../components/appointments/ReservationStatusBadge';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogTitle,
  Input,
  Label,
  Select,
  Separator,
  Tabs,
  Textarea,
} from '../../../components/shad';
import { AlertDialog } from '../../../components/shad/alert-dialog';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { todayIn, zonedParts } from '../../../lib/time';
import { CustomerMessagesTab } from '../messages/CustomerMessagesTab';
import { formatCurrency } from '../reservations/model';
import { CounselingSheet } from './CounselingSheet';
import { formatWhen, isStaffOrigin, lookupAddress, splitName } from './shared';

type Tab = 'reservations' | 'karutes' | 'counseling' | 'messages';

/** ?tab= of links from other screens (the karte editor links with tab=kartes) */
function initialTab(param: string | null): Tab {
  if (param === 'reservations' || param === 'counseling' || param === 'messages') return param;
  return 'karutes';
}

interface HistoryRow {
  id: string;
  at: string;
  /** an entry carried over from the previous system has no time of day and no live status */
  legacy: boolean;
  menu: string;
  staff: string | null;
  status: AppointmentStatus;
  price: number;
  note: string | null;
}

const EMPTY_FORM = {
  last_name: '',
  first_name: '',
  last_name_kana: '',
  first_name_kana: '',
  gender: '',
  birthday: '',
  occupation: '',
  postal_code: '',
  address: '',
  phone: '',
  email: '',
  memo: '',
};

function toForm(c: CustomerDetail): typeof EMPTY_FORM {
  // records that only have a full name in one field are split at the first space
  const [last, first] = c.last_name || c.first_name ? [c.last_name, c.first_name] : splitName(c.display_name);
  return {
    last_name: last,
    first_name: first,
    last_name_kana: c.last_name_kana ?? '',
    first_name_kana: c.first_name_kana ?? '',
    gender: c.gender && c.gender !== 'unknown' ? c.gender : '',
    birthday: c.birthday ?? '',
    occupation: c.occupation ?? '',
    postal_code: c.postal_code ?? '',
    address: c.address ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    memo: c.memo ?? '',
  };
}

/** 顧客詳細: profile card + 予約履歴 / カルテ / カウンセリング / メッセージ */
export default function CustomerShow() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, timezone: tz, currentShopId } = useAuth();
  // opened from 顧客管理 (?from=manage) the back button returns there, otherwise to カルテ
  const backPath = params.get('from') === 'manage' ? '/app/customers/manage' : '/app/customers';

  const customerQ = useCustomer(id);
  const c = customerQ.data;
  const overviewQ = useQuery({
    queryKey: customerKeys.overview(id),
    queryFn: () => customersApi.overview(id),
    enabled: !!c,
  });
  // the whole reservation history (the previous screen's 来店履歴 tab keeps its shorter list)
  const visitsQ = useQuery({
    queryKey: [...customerKeys.visits(id), 'all'],
    queryFn: () => customersApi.visits(id, 500),
    enabled: !!c,
  });
  const legacyQ = useQuery({
    queryKey: customerKeys.legacyVisits(id),
    queryFn: () => customersApi.legacyVisits(id),
    enabled: !!c,
  });
  const memosQ = useQuery({ queryKey: customerKeys.memos(id), queryFn: () => customersApi.memos(id), enabled: !!c });
  const canKarte = can('karte.read');
  const kartesQ = useKartes({ customerId: id, limit: 100 }, !!c && canKarte);
  const kartes = kartesQ.data?.pages.flatMap((p) => p.items) ?? [];

  const [tab, setTab] = useState<Tab>(() => initialTab(params.get('tab')));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [searchingAddress, setSearchingAddress] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creatingKarte, setCreatingKarte] = useState(false);
  const set = (patch: Partial<typeof EMPTY_FORM>) => setForm((f) => ({ ...f, ...patch }));

  const history = useMemo<HistoryRow[]>(() => {
    const rows: HistoryRow[] = [
      ...(visitsQ.data ?? []).map((v) => ({
        id: v.id,
        at: v.start_at,
        legacy: false,
        menu: v.services.map((s) => s.name).join('、'),
        staff: v.staff_name,
        status: v.status,
        price: v.transaction?.total ?? v.estimated_total ?? 0,
        note: null,
      })),
      ...(legacyQ.data ?? []).map((v) => ({
        id: v.id,
        at: v.visited_at,
        legacy: true,
        menu: v.menu_text ?? '',
        staff: v.staff_name,
        status: 'completed' as const,
        price: v.amount ?? 0,
        note: v.memo,
      })),
    ];
    return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [visitsQ.data, legacyQ.data]);

  if (customerQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }
  if (!c) {
    return (
      <div className="sy-4">
        <Button variant="ghost" onClick={() => navigate(backPath)}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          顧客一覧に戻る
        </Button>
        <div className="py-8 text-center text-muted-foreground">顧客が見つかりません</div>
      </div>
    );
  }

  const overview = overviewQ.data;
  const merged = c.status === 'merged';
  const kana = `${c.last_name_kana ?? ''} ${c.first_name_kana ?? ''}`.trim();
  const memberNo = overview?.member_no ?? c.member_no ?? c.customer_number;
  const lineNamed = (overview?.name_source ?? c.name_source) === 'line';
  const staffOrigin = isStaffOrigin(c.acquisition_source);
  const assigned = overview?.assigned_staff ?? [];
  const linked = overview?.linked_customers ?? [];
  const staffMemos = (memosQ.data ?? []).filter((m) => m.visibility === 'shared');

  const openEdit = () => {
    setForm(toForm(c));
    setEditing(true);
  };

  const onPostalCode = async (value: string) => {
    set({ postal_code: value });
    if (value.replace(/-/g, '').length !== 7) return;
    setSearchingAddress(true);
    const address = await lookupAddress(value);
    if (address) set({ address });
    setSearchingAddress(false);
  };

  const save = async () => {
    if (!form.last_name.trim()) return;
    setSaving(true);
    try {
      const input: CustomerInput = {
        lastName: form.last_name,
        firstName: form.first_name,
        lastNameKana: form.last_name_kana,
        firstNameKana: form.first_name_kana,
        gender: (form.gender || null) as CustomerInput['gender'],
        birthday: form.birthday || null,
        occupation: form.occupation || null,
        postalCode: form.postal_code || null,
        address: form.address || null,
        phone: form.phone || null,
        email: form.email || null,
        memo: form.memo || null,
      };
      const updated = await customersApi.update(c.id, input);
      qc.setQueryData(customerKeys.detail(c.id), updated);
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      setEditing(false);
    } catch (e) {
      toast.error('顧客情報の更新に失敗しました', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await customersApi.remove(c.id);
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      navigate(backPath);
    } catch (e) {
      toast.error('顧客の削除に失敗しました', errorMessage(e));
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  // a new karte starts as today's record by the signed-in staff member and opens for editing
  const addKarte = async () => {
    if (!currentShopId) return;
    setCreatingKarte(true);
    try {
      const karte = await kartesApi.create({ customerId: c.id, shopId: currentShopId, visitDate: todayIn(tz), fields: {} });
      void qc.invalidateQueries({ queryKey: karteKeys.all });
      navigate(`/app/customers/kartes/${karte.id}?edit=1`);
    } catch (e) {
      toast.error('カルテの作成に失敗しました', errorMessage(e));
    } finally {
      setCreatingKarte(false);
    }
  };

  const historyDate = (row: HistoryRow) => {
    if (row.legacy && zonedParts(row.at, tz).time === '00:00') {
      return new Date(row.at).toLocaleDateString('ja-JP', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric' });
    }
    return formatWhen(row.at, tz, 'datetime');
  };

  return (
    <div className="sy-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="顧客一覧に戻る" onClick={() => navigate(backPath)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-bold md:text-2xl">
              {c.display_name}
              {lineNamed ? (
                <Badge variant="outline" className="ml-2 border-amber-500 align-middle text-[10px] text-amber-600">
                  本名未登録（LINE表示名）
                </Badge>
              ) : null}
            </h1>
            {kana ? <p className="text-sm text-muted-foreground">{kana}</p> : null}
            {memberNo ? (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">会員番号: {memberNo}</p>
            ) : null}
          </div>
        </div>
        {!merged ? (
          <div className="flex items-center gap-2">
            {can('customer.write') ? (
              <Button variant="outline" size="sm" onClick={openEdit}>
                <SquarePen className="mr-2 h-4 w-4" />
                編集
              </Button>
            ) : null}
            {can('customer.delete') ? (
              <Button variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)}>
                <Trash2 className="mr-2 h-4 w-4" />
                削除
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {merged ? (
        <div className="rounded-lg border border-yellow-500 bg-yellow-50 p-3 text-sm text-yellow-800">
          この顧客は統合済みです。予約・カルテなどの履歴は統合先の顧客に移動しています。
          {c.merged_into_id ? (
            <Link to={`/app/customers/${c.merged_into_id}`} className="ml-2 font-medium underline">
              統合先を開く
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-4">
        <Card className="lg:col-span-1">
          <CardHeader className="text-center">
            <Avatar
              name={c.display_name}
              src={overview?.line?.picture_url}
              className="mx-auto h-20 w-20"
              fallbackClassName="text-2xl"
            />
          </CardHeader>
          <CardContent className="sy-4">
            <div className="flex items-center gap-3 text-sm">
              <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span>{c.phone || '未設定'}</span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{c.email || '未設定'}</span>
            </div>
            {c.address || c.postal_code ? (
              <div className="flex items-start gap-3 text-sm">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  {c.postal_code ? `〒${c.postal_code} ` : ''}
                  {c.address}
                </span>
              </div>
            ) : null}
            {c.occupation ? (
              <div className="flex items-center gap-3 text-sm">
                <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{c.occupation}</span>
              </div>
            ) : null}
            <Separator />
            <div className="sy-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">来店回数</span>
                <span className="font-medium">{c.visit_count}回</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">最終来店</span>
                <span className="font-medium">{c.last_visit_at ? formatWhen(c.last_visit_at, tz, 'date') : 'なし'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">性別</span>
                <span className="font-medium">
                  {c.gender === 'male' ? '男性' : c.gender === 'female' ? '女性' : c.gender === 'other' ? 'その他' : '未設定'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">誕生日</span>
                <span className="font-medium">{c.birthday || '未設定'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">集客元</span>
                <Badge variant={staffOrigin ? 'outline' : 'secondary'} className={staffOrigin ? 'border-blue-400 text-blue-600' : ''}>
                  {staffOrigin ? 'スタッフ集客' : '店舗集客'}
                </Badge>
              </div>
            </div>
            {c.memo || staffMemos.length ? (
              <>
                <Separator />
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">メモ</p>
                  {c.memo ? <p className="whitespace-pre-wrap text-sm">{c.memo}</p> : null}
                  {staffMemos.map((m) => (
                    <p key={m.id} className="mt-1 whitespace-pre-wrap text-sm" data-staff-memo={m.id}>
                      {m.body}
                    </p>
                  ))}
                </div>
              </>
            ) : null}
            <Separator />
            <div className="sy-2">
              <label className="text-sm text-muted-foreground">最近の担当</label>
              <p className="text-[11px] text-muted-foreground">
                予約履歴から自動で決まります（直近の指名予約の担当 → 直近の予約の担当、在籍者のみ）。担当は予約ごとに設定してください。
              </p>
              {overviewQ.isSuccess && assigned.length === 0 ? (
                <p className="text-sm text-muted-foreground">未定（来店済みの予約がありません）</p>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {assigned.map((s) => (
                  <Badge key={s.staff_id} variant={s.is_primary ? 'default' : 'secondary'}>
                    {s.staff_name}
                    {s.is_primary ? '' : `（来店${s.visit_count}回）`}
                  </Badge>
                ))}
              </div>
            </div>
            {linked.length > 0 ? (
              <>
                <Separator />
                <div className="sy-2">
                  <p className="text-xs text-muted-foreground">同一会員番号のリンク済みレコード（他店舗含む）</p>
                  {linked.map((l) => (
                    <div
                      key={l.id}
                      onClick={() => navigate(`/app/customers/${l.id}`)}
                      className="sy-0.5 cursor-pointer rounded-md border p-2 text-xs transition-colors hover:bg-accent"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{l.store_name}</span>
                        <span className="text-muted-foreground">来店{l.visit_count || 0}回</span>
                      </div>
                      <div className="text-muted-foreground">
                        {l.staff_name ? <span>担当: {l.staff_name}{'\u3000'}</span> : null}
                        {l.last_visit_at ? <span>最終来店: {zonedParts(l.last_visit_at, tz).date}</span> : null}
                        {!l.last_visit_at && l.last_reservation_at ? (
                          <span>直近予約: {zonedParts(l.last_reservation_at, tz).date}</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            <Separator />
            <Link
              to={`/app/customers-classic/${c.id}`}
              data-testid="customer-classic-link"
              className="block text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              タグ・スタッフメモ・ポイント・書類・統合履歴を開く
            </Link>
          </CardContent>
        </Card>

        <div className="lg:col-span-3">
          <Tabs
            label="顧客情報"
            value={tab}
            onValueChange={setTab}
            listClassName="w-full grid grid-cols-4"
            triggerClassName="text-xs sm:text-sm"
            items={[
              {
                value: 'reservations',
                label: (
                  <>
                    <Calendar className="mr-1 h-3 w-3 sm:mr-2 sm:h-4 sm:w-4" />
                    <span className="hidden sm:inline">予約履歴</span>
                    <span className="sm:hidden">予約</span>
                  </>
                ),
              },
              {
                value: 'karutes',
                label: (
                  <>
                    <FileText className="mr-1 h-3 w-3 sm:mr-2 sm:h-4 sm:w-4" />
                    カルテ
                  </>
                ),
              },
              {
                value: 'counseling',
                label: (
                  <>
                    <ClipboardList className="mr-1 h-3 w-3 sm:mr-2 sm:h-4 sm:w-4" />
                    <span className="hidden sm:inline">カウンセリング</span>
                    <span className="sm:hidden">問診</span>
                  </>
                ),
              },
              {
                value: 'messages',
                label: (
                  <>
                    <span className="hidden sm:inline">メッセージ</span>
                    <span className="sm:hidden">MSG</span>
                  </>
                ),
              },
            ]}
          />

          {tab === 'reservations' ? (
            <div role="tabpanel" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">予約履歴</CardTitle>
                  <CardDescription>{history.length}件</CardDescription>
                </CardHeader>
                <CardContent>
                  {visitsQ.isLoading || legacyQ.isLoading ? (
                    <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
                  ) : history.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">予約履歴がありません</div>
                  ) : (
                    <div className="sy-3">
                      {history.map((row) => (
                        <div key={row.id} className="rounded-lg border p-3" data-history={row.legacy ? 'legacy' : 'reservation'}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium">{historyDate(row)}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {row.menu} / {row.staff}
                              </div>
                              {row.note ? (
                                <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{row.note}</div>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <ReservationStatusBadge status={row.status} />
                              <span className="text-sm font-medium">{formatCurrency(row.price)}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          {tab === 'karutes' ? (
            <div role="tabpanel" className="mt-4">
              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex flex-col sy-1.5">
                      <CardTitle className="text-base">カルテ</CardTitle>
                      <CardDescription>
                        {kartes.length}
                        {kartesQ.hasNextPage ? '+' : ''}件
                      </CardDescription>
                    </div>
                    {can('karte.write') && currentShopId && !merged ? (
                      <Button variant="outline" size="sm" onClick={() => void addKarte()} disabled={creatingKarte}>
                        <Plus className="mr-1 h-4 w-4" />
                        {creatingKarte ? '作成中...' : '追加'}
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent>
                  {!canKarte ? (
                    <div className="py-8 text-center text-muted-foreground">カルテを閲覧する権限がありません</div>
                  ) : kartesQ.isLoading ? (
                    <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
                  ) : kartes.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">カルテがありません</div>
                  ) : (
                    <div className="sy-3">
                      {kartes.map((k) => {
                        const menu = typeof k.fields?.menu_content === 'string' ? k.fields.menu_content : '';
                        return (
                          <div
                            key={k.id}
                            data-karte={k.id}
                            className="cursor-pointer rounded-lg border p-3 transition-colors hover:bg-accent"
                            onClick={() => navigate(`/app/customers/kartes/${k.id}`)}
                          >
                            <div className="flex items-center justify-between">
                              <div className="font-medium">{formatWhen(k.visit_date, tz, 'date')}</div>
                              <div className="flex items-center gap-2">
                                {k.shared_with_customer ? (
                                  <Badge variant="success">共有済み</Badge>
                                ) : (
                                  <Badge variant="outline">未共有</Badge>
                                )}
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                              </div>
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                              {menu || k.template_name || '施術内容なし'}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">担当: {k.staff_name}</div>
                          </div>
                        );
                      })}
                      {kartesQ.hasNextPage ? (
                        <div className="pt-2 text-center">
                          <Button
                            variant="outline"
                            onClick={() => void kartesQ.fetchNextPage()}
                            disabled={kartesQ.isFetchingNextPage}
                          >
                            {kartesQ.isFetchingNextPage ? '読み込み中...' : 'もっと見る'}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          {tab === 'counseling' ? (
            <div role="tabpanel" className="mt-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">カウンセリングシート</CardTitle>
                  <CardDescription>事前問診・ご要望</CardDescription>
                </CardHeader>
                <CardContent>
                  {canKarte ? (
                    <CounselingSheet customerId={c.id} shopId={currentShopId} />
                  ) : (
                    <div className="py-8 text-center text-muted-foreground">
                      カウンセリングシートを閲覧する権限がありません
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          {tab === 'messages' ? (
            <div role="tabpanel" className="mt-4 text-[14px] leading-[1.6]">
              <CustomerMessagesTab customerId={c.id} customerName={c.display_name} />
            </div>
          ) : null}
        </div>
      </div>

      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title={<DialogTitle>顧客情報を編集</DialogTitle>}
        className="max-h-[90vh] max-w-2xl overflow-y-auto"
      >
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="sy-2">
              <Label htmlFor="edit-last-name">
                姓 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-last-name"
                placeholder="例: 山田"
                value={form.last_name}
                onChange={(e) => set({ last_name: e.target.value })}
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="edit-first-name">名</Label>
              <Input
                id="edit-first-name"
                placeholder="例: 花子"
                value={form.first_name}
                onChange={(e) => set({ first_name: e.target.value })}
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="edit-last-kana">セイ</Label>
              <Input
                id="edit-last-kana"
                placeholder="例: ヤマダ"
                value={form.last_name_kana}
                onChange={(e) => set({ last_name_kana: e.target.value })}
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="edit-first-kana">メイ</Label>
              <Input
                id="edit-first-kana"
                placeholder="例: ハナコ"
                value={form.first_name_kana}
                onChange={(e) => set({ first_name_kana: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="sy-2">
              <Label>性別</Label>
              <Select
                label="性別"
                value={form.gender}
                onValueChange={(gender) => set({ gender })}
                placeholder="選択してください"
                options={[
                  { value: 'female', label: '女性' },
                  { value: 'male', label: '男性' },
                  { value: 'other', label: 'その他' },
                ]}
              />
            </div>
            <div className="sy-2">
              <Label htmlFor="edit-birthday">生年月日</Label>
              <Input
                id="edit-birthday"
                type="date"
                value={form.birthday}
                onChange={(e) => set({ birthday: e.target.value })}
              />
            </div>
          </div>
          <div className="sy-2">
            <Label htmlFor="edit-occupation">職業</Label>
            <Input id="edit-occupation" value={form.occupation} onChange={(e) => set({ occupation: e.target.value })} />
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-4">
            <div className="sy-2">
              <Label htmlFor="edit-phone">電話番号</Label>
              <Input id="edit-phone" type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
            </div>
            <div className="sy-2">
              <Label htmlFor="edit-email">メールアドレス</Label>
              <Input id="edit-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} />
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-3 gap-4">
            <div className="sy-2">
              <Label htmlFor="edit-postal">郵便番号</Label>
              <div className="relative">
                <Input
                  id="edit-postal"
                  value={form.postal_code}
                  onChange={(e) => void onPostalCode(e.target.value)}
                  placeholder="123-4567"
                />
                {searchingAddress ? (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  </div>
                ) : null}
              </div>
            </div>
            <div className="col-span-2 sy-2">
              <Label htmlFor="edit-address">住所</Label>
              <Input id="edit-address" value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </div>
          </div>
          <Separator />
          <div className="sy-2">
            <Label htmlFor="edit-memo">メモ</Label>
            <Textarea id="edit-memo" value={form.memo} onChange={(e) => set({ memo: e.target.value })} rows={3} />
          </div>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:sx-2">
          <Button variant="outline" onClick={() => setEditing(false)}>
            キャンセル
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </Dialog>

      <AlertDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="顧客を削除しますか？"
        description={`「${c.display_name}」を削除します。この操作は取り消せません。`}
        actionLabel={deleting ? '削除中...' : '削除する'}
        actionClassName="bg-destructive text-destructive-foreground hover:bg-destructive/90"
        onAction={() => void remove()}
        busy={deleting}
      />
    </div>
  );
}
