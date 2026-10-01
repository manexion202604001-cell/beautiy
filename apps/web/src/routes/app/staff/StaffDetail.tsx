import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { orgApi, orgKeys, useRoles, useStaffList, useStaffMember } from '../../../api/org';
import { scheduleKeys, schedulesApi, useBusinessHours } from '../../../api/schedules';
import type { Staff } from '../../../api/types';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  PageSpinner,
  Segmented,
  Select,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { WEEKDAYS_JA, formatDate, formatYen } from '../../../lib/format';
import { todayIn } from '../../../lib/time';
import { EMPLOYMENT_LABEL, STAFF_COLORS, STAFF_STATUS } from './shared';

type Tab = 'profile' | 'role' | 'shops' | 'schedule';

export default function StaffDetail() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'profile';
  const q = useStaffMember(id);
  const { shops, can } = useAuth();
  if (q.isLoading) return <PageSpinner />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  if (!s) return null;
  const st = STAFF_STATUS[s.status];
  return (
    <div className="space-y-5">
      <Link to="/app/staff" className="text-[13px] text-muted hover:text-fg">
        ← スタッフ一覧
      </Link>
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={s.display_name} color={s.color} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              {s.display_name}
              {st ? <Badge tone={st.tone}>{st.label}</Badge> : null}
              {s.role ? <Badge tone="primary">{s.role.name}</Badge> : null}
            </h1>
            <p className="text-[13px] text-muted">
              {[
                s.title,
                EMPLOYMENT_LABEL[s.employment_type],
                s.email,
                s.shops
                  .map((a) => shops.find((x) => x.id === a.shop_id)?.name ?? '他店舗')
                  .join('・'),
              ]
                .filter(Boolean)
                .join(' ・ ')}
            </p>
          </div>
          <div className="text-right text-[13px]">
            <p className="text-muted">指名料</p>
            <p className="text-lg font-semibold tabular">{formatYen(s.nomination_fee)}</p>
          </div>
        </div>
      </Card>
      <div>
        <Tabs
          idBase="staff"
          label="スタッフ情報"
          value={tab}
          onChange={(t) => setParams(t === 'profile' ? {} : { tab: t }, { replace: true })}
          items={[
            { value: 'profile', label: '基本情報' },
            { value: 'role', label: '権限' },
            { value: 'shops', label: '所属・異動' },
            { value: 'schedule', label: '勤務パターン' },
          ]}
        />
        <div className="pt-5">
          <TabPanel idBase="staff" value={tab}>
            {tab === 'profile' ? <ProfileTab s={s} editable={can('staff.manage')} /> : null}
            {tab === 'role' ? <RoleTab s={s} /> : null}
            {tab === 'shops' ? <ShopsTab s={s} /> : null}
            {tab === 'schedule' ? <ScheduleTab s={s} /> : null}
          </TabPanel>
        </div>
      </div>
    </div>
  );
}

function ProfileTab({ s, editable }: { s: Staff; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const self = me?.staff.id === s.id;
  const canEdit = editable || self;
  const [f, setF] = useState(() => ({
    displayName: s.display_name,
    displayNameKana: s.display_name_kana ?? '',
    email: s.email ?? '',
    phone: s.phone ?? '',
    title: s.title ?? '',
    employmentType: s.employment_type,
    color: s.color,
    isBookable: s.is_bookable,
    nominationFee: String(s.nomination_fee),
    sortOrder: String(s.sort_order),
    publicSlug: s.public_slug ?? '',
    status: s.status,
    bio: s.public_profile?.bio ?? '',
    specialties: (s.public_profile?.specialties ?? []).join('、'),
    instagram: s.public_profile?.instagram ?? '',
    years:
      s.public_profile?.yearsOfExperience != null ? String(s.public_profile.yearsOfExperience) : '',
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const publicProfile = {
      bio: f.bio.trim() || undefined,
      specialties: f.specialties
        .split(/[、,]/)
        .map((x) => x.trim())
        .filter(Boolean),
      instagram: f.instagram.trim() || undefined,
      yearsOfExperience: f.years ? Number(f.years) : undefined,
    };
    try {
      // self-service (without staff.manage) may only change profile/kana/phone/color
      const input = editable
        ? {
            displayName: f.displayName.trim(),
            displayNameKana: f.displayNameKana.trim() || undefined,
            email: f.email.trim() || undefined,
            phone: f.phone.trim() || undefined,
            title: f.title.trim() || undefined,
            employmentType: f.employmentType,
            color: f.color,
            isBookable: f.isBookable,
            nominationFee: Number(f.nominationFee) || 0,
            sortOrder: Number(f.sortOrder) || 0,
            publicSlug: f.publicSlug.trim() || undefined,
            status: f.status,
            publicProfile,
          }
        : {
            displayNameKana: f.displayNameKana.trim() || undefined,
            phone: f.phone.trim() || undefined,
            color: f.color,
            publicProfile,
          };
      const updated = await orgApi.updateStaff(s.id, input);
      qc.setQueryData(orgKeys.staffMember(s.id), updated);
      void qc.invalidateQueries({ queryKey: orgKeys.staffAll });
      toast.success('スタッフ情報を保存しました');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const ro = !editable;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <h2 className="mb-4 text-[15px] font-semibold">基本情報</h2>
        {error ? (
          <Alert tone="danger" className="mb-4">
            {error}
          </Alert>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="表示名" required>
            <Input
              value={f.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              disabled={ro}
            />
          </Field>
          <Field label="フリガナ">
            <Input
              value={f.displayNameKana}
              onChange={(e) => set('displayNameKana', e.target.value)}
              disabled={!canEdit}
            />
          </Field>
          <Field label="メールアドレス">
            <Input
              type="email"
              value={f.email}
              onChange={(e) => set('email', e.target.value)}
              disabled={ro}
            />
          </Field>
          <Field label="電話番号">
            <Input
              type="tel"
              value={f.phone}
              onChange={(e) => set('phone', e.target.value)}
              disabled={!canEdit}
            />
          </Field>
          <Field label="肩書き">
            <Input value={f.title} onChange={(e) => set('title', e.target.value)} disabled={ro} />
          </Field>
          <Field label="雇用形態">
            <Select
              value={f.employmentType}
              onChange={(e) => set('employmentType', e.target.value as Staff['employment_type'])}
              disabled={ro}
            >
              {Object.entries(EMPLOYMENT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="指名料">
            <Input
              type="number"
              min={0}
              step={10}
              value={f.nominationFee}
              onChange={(e) => set('nominationFee', e.target.value)}
              leading="¥"
              disabled={ro}
            />
          </Field>
          <Field label="表示順">
            <Input
              type="number"
              value={f.sortOrder}
              onChange={(e) => set('sortOrder', e.target.value)}
              disabled={ro}
            />
          </Field>
          <Field label="在籍状況">
            <Select
              value={f.status}
              onChange={(e) => set('status', e.target.value as Staff['status'])}
              disabled={ro}
            >
              {Object.entries(STAFF_STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox
              label="予約を受け付ける"
              checked={f.isBookable}
              onChange={(e) => set('isBookable', e.target.checked)}
              disabled={ro}
            />
          </div>
        </div>
        <div className="mt-4">
          <p className="mb-1.5 text-xs text-muted">カレンダーの色</p>
          <div className="flex gap-1.5" role="radiogroup" aria-label="カレンダーの色">
            {STAFF_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={f.color === c}
                aria-label={c}
                disabled={!canEdit}
                onClick={() => set('color', c)}
                className={`h-8 w-8 rounded-full border-2 ${f.color === c ? 'border-fg' : 'border-transparent'}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <p className="mt-4 text-xs text-muted">登録日: {formatDate(s.created_at)}</p>
      </Card>
      <Card>
        <h2 className="text-[15px] font-semibold">公開プロフィール</h2>
        <p className="mb-4 mt-0.5 text-[13px] text-muted">
          予約ページのスタイリスト選択に表示されます。
        </p>
        <div className="space-y-4">
          <Field label="自己紹介">
            <Textarea
              value={f.bio}
              onChange={(e) => set('bio', e.target.value)}
              rows={4}
              maxLength={2000}
              disabled={!canEdit}
            />
          </Field>
          <Field label="得意なスタイル" hint="読点（、）区切り">
            <Input
              value={f.specialties}
              onChange={(e) => set('specialties', e.target.value)}
              disabled={!canEdit}
              placeholder="ショート、透明感カラー"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="経験年数">
              <Input
                type="number"
                min={0}
                max={80}
                value={f.years}
                onChange={(e) => set('years', e.target.value)}
                trailing="年"
                disabled={!canEdit}
              />
            </Field>
            <Field label="Instagram">
              <Input
                value={f.instagram}
                onChange={(e) => set('instagram', e.target.value)}
                leading="@"
                disabled={!canEdit}
              />
            </Field>
          </div>
          <Field label="公開URL用ID" hint="英数字">
            <Input
              value={f.publicSlug}
              onChange={(e) => set('publicSlug', e.target.value)}
              disabled={ro}
            />
          </Field>
        </div>
        {canEdit ? (
          <div className="mt-5 flex justify-end">
            <Button variant="primary" loading={saving} onClick={save}>
              保存
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function RoleTab({ s }: { s: Staff }) {
  const { can } = useAuth();
  const roles = useRoles();
  const qc = useQueryClient();
  const toast = useToast();
  const [roleId, setRoleId] = useState(s.role_id);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = roles.data?.find((r) => r.id === s.role_id);
  const next = roles.data?.find((r) => r.id === roleId);
  const manage = can('role.manage');

  const apply = async () => {
    setSaving(true);
    try {
      const updated = await orgApi.changeRole(s.id, roleId);
      qc.setQueryData(orgKeys.staffMember(s.id), updated);
      void qc.invalidateQueries({ queryKey: orgKeys.staffAll });
      toast.success('権限を変更しました', '変更は監査ログに記録されました');
      setConfirm(false);
    } catch (e) {
      toast.error(e);
      setConfirm(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="max-w-2xl">
      <h2 className="text-[15px] font-semibold">権限ロール</h2>
      <p className="mb-4 mt-0.5 text-[13px] text-muted">
        ロールによって操作できる機能が決まります。権限の変更は監査ログに記録されます。
      </p>
      {!manage ? (
        <Alert tone="info" className="mb-4">
          権限の変更には「権限ロールの変更（role.manage）」が必要です。
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Field label="ロール">
            <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={!manage}>
              {(roles.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.is_system ? '' : '（カスタム）'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {manage ? (
          <Button
            variant="primary"
            disabled={roleId === s.role_id}
            onClick={() => setConfirm(true)}
          >
            変更する
          </Button>
        ) : null}
      </div>
      {next ? (
        <div className="mt-4 rounded-xl bg-surface-2/60 p-3">
          <p className="text-[13px] font-medium">{next.name}</p>
          {next.description ? <p className="text-xs text-muted">{next.description}</p> : null}
          <p className="mt-1 text-xs text-muted">{next.permissions.length}個の権限</p>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="権限を変更しますか？"
        description={`${s.display_name} の権限を「${current?.name ?? ''}」から「${next?.name ?? ''}」に変更します。この操作は監査ログに記録されます。`}
        confirmLabel="変更する"
        loading={saving}
        onConfirm={apply}
      />
    </Card>
  );
}

function ShopsTab({ s }: { s: Staff }) {
  const { shops, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState(s.shops.map((a) => a.shop_id));
  const [saving, setSaving] = useState(false);
  const [transfer, setTransfer] = useState(false);
  useEffect(() => setSelected(s.shops.map((a) => a.shop_id)), [s.shops]);
  const manage = can('staff.manage');
  const dirty =
    [...selected].sort().join() !==
    s.shops
      .map((a) => a.shop_id)
      .sort()
      .join();

  const save = async () => {
    setSaving(true);
    try {
      const updated = await orgApi.setShops(s.id, selected);
      qc.setQueryData(orgKeys.staffMember(s.id), updated);
      void qc.invalidateQueries({ queryKey: orgKeys.staffAll });
      toast.success('所属店舗を更新しました');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <h2 className="text-[15px] font-semibold">所属店舗</h2>
        <p className="mb-4 mt-0.5 text-[13px] text-muted">
          兼務する店舗をすべて選択します。所属店舗のカレンダー・顧客にアクセスできます。
        </p>
        <div className="space-y-2.5">
          {shops.map((shop) => {
            const a = s.shops.find((x) => x.shop_id === shop.id);
            return (
              <Checkbox
                key={shop.id}
                label={shop.name}
                description={
                  a
                    ? `${a.is_primary ? '主所属 ・ ' : ''}${a.started_on ? `${formatDate(a.started_on, undefined, { weekday: false })}〜` : ''}`
                    : undefined
                }
                checked={selected.includes(shop.id)}
                disabled={!manage}
                onChange={(e) =>
                  setSelected((x) =>
                    e.target.checked ? [...x, shop.id] : x.filter((y) => y !== shop.id),
                  )
                }
              />
            );
          })}
        </div>
        {manage ? (
          <div className="mt-5 flex justify-end">
            <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>
              保存
            </Button>
          </div>
        ) : null}
      </Card>
      <Card>
        <h2 className="text-[15px] font-semibold">異動</h2>
        <p className="mb-4 mt-0.5 text-[13px] text-muted">
          店舗を異動させ、担当していた顧客の引き継ぎ方法を選べます（引き継ぎ・別スタッフへ再割当・担当解除）。
        </p>
        <Button
          icon="refresh"
          disabled={!manage || !s.shops.length || shops.length < 2}
          onClick={() => setTransfer(true)}
        >
          異動を登録
        </Button>
      </Card>
      {transfer ? <TransferDialog s={s} onClose={() => setTransfer(false)} /> : null}
    </div>
  );
}

function TransferDialog({ s, onClose }: { s: Staff; onClose: () => void }) {
  const { shops, timezone: tz } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [fromShopId, setFrom] = useState(s.shops[0]?.shop_id ?? '');
  const [toShopId, setTo] = useState(
    shops.find((x) => !s.shops.some((a) => a.shop_id === x.id))?.id ?? '',
  );
  const [effectiveDate, setDate] = useState(todayIn(tz));
  const [policy, setPolicy] = useState<'keep' | 'reassign' | 'unassign'>('keep');
  const [reassignTo, setReassignTo] = useState('');
  const others = useStaffList({ shopId: fromShopId || undefined });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!fromShopId || !toShopId) return setError('異動元と異動先を選択してください');
    if (fromShopId === toShopId) return setError('異動元と異動先が同じです');
    if (policy === 'reassign' && !reassignTo)
      return setError('引き継ぎ先のスタッフを選択してください');
    setSaving(true);
    setError(null);
    try {
      const res = await orgApi.transfer(s.id, {
        fromShopId,
        toShopId,
        effectiveDate,
        customerPolicy: policy,
        reassignToStaffId: policy === 'reassign' ? reassignTo : undefined,
      });
      qc.setQueryData(orgKeys.staffMember(s.id), res.staff);
      void qc.invalidateQueries({ queryKey: orgKeys.staffAll });
      toast.success(
        '異動を登録しました',
        policy === 'keep' ? undefined : `${res.affectedCustomers}名の顧客の担当を変更しました`,
      );
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${s.display_name} の異動`}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            異動を登録
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="異動元">
            <Select value={fromShopId} onChange={(e) => setFrom(e.target.value)}>
              {s.shops.map((a) => (
                <option key={a.shop_id} value={a.shop_id}>
                  {shops.find((x) => x.id === a.shop_id)?.name ?? a.shop_id}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="異動先">
            <Select value={toShopId} onChange={(e) => setTo(e.target.value)}>
              <option value="">選択してください</option>
              {shops
                .filter((x) => x.id !== fromShopId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Field label="異動日">
          <Input type="date" value={effectiveDate} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">担当顧客の扱い</legend>
          <Segmented
            label="担当顧客の扱い"
            value={policy}
            onChange={setPolicy}
            options={[
              { value: 'keep', label: '引き続き担当' },
              { value: 'reassign', label: '別スタッフに引き継ぐ' },
              { value: 'unassign', label: '担当を外す' },
            ]}
          />
          <p className="mt-2 text-xs text-muted">
            {policy === 'keep'
              ? '顧客の担当スタッフは変わりません（異動先でも担当を続けます）。'
              : policy === 'reassign'
                ? '異動元店舗で担当していた顧客を、指定したスタッフに引き継ぎます。'
                : '異動元店舗での担当関係を終了します。顧客は店舗に残ります。'}
          </p>
        </fieldset>
        {policy === 'reassign' ? (
          <Field label="引き継ぎ先スタッフ">
            <Select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
              <option value="">選択してください</option>
              {(others.data ?? [])
                .filter((x) => x.id !== s.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
            </Select>
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

interface DayRow {
  on: boolean;
  start: string;
  end: string;
}

/** Weekly working pattern (one range per weekday) for staff × shop */
function ScheduleTab({ s }: { s: Staff }) {
  const { shops, can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const myShops = shops.filter((x) => s.shops.some((a) => a.shop_id === x.id));
  const [shopId, setShopId] = useState(myShops[0]?.id ?? '');
  const hours = useBusinessHours(shopId);
  const q = useQuery({
    queryKey: scheduleKeys.weekly(s.id, shopId),
    queryFn: () => schedulesApi.weekly(s.id, shopId),
    enabled: !!shopId,
  });
  const [rows, setRows] = useState<DayRow[]>([]);
  const [saving, setSaving] = useState(false);
  const editable = can('schedule.manage') || me?.staff.id === s.id;
  const configured = (q.data?.length ?? 0) > 0;

  const defaults = useMemo(() => {
    return [0, 1, 2, 3, 4, 5, 6].map((wd) => {
      const h = hours.data?.find((x) => x.weekday === wd);
      return { start: h?.open_time ?? '10:00', end: h?.close_time ?? '19:00', open: !!h };
    });
  }, [hours.data]);

  useEffect(() => {
    if (!q.data) return;
    setRows(
      [0, 1, 2, 3, 4, 5, 6].map((wd) => {
        const r = q.data.find((x) => x.weekday === wd);
        return r
          ? { on: true, start: r.start_time, end: r.end_time }
          : {
              on: !configured && defaults[wd]!.open,
              start: defaults[wd]!.start,
              end: defaults[wd]!.end,
            };
      }),
    );
  }, [q.data, defaults, configured]);

  const save = async () => {
    const payload = rows.map((r, wd) => ({ ...r, wd })).filter((r) => r.on);
    if (payload.some((r) => r.end <= r.start)) {
      toast.error('終了時刻は開始時刻より後にしてください');
      return;
    }
    setSaving(true);
    try {
      await schedulesApi.replaceWeekly(
        s.id,
        shopId,
        payload.map((r) => ({ weekday: r.wd, startTime: r.start, endTime: r.end })),
      );
      void qc.invalidateQueries({ queryKey: scheduleKeys.all });
      toast.success('勤務パターンを保存しました');
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  if (!myShops.length)
    return (
      <Alert tone="info">所属店舗がありません。「所属・異動」タブで店舗を設定してください。</Alert>
    );
  // Monday-first display order
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <Card className="max-w-3xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold">基本の勤務パターン</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            毎週の出勤日と時間です。日ごとの変更は「シフト」画面で行います。
          </p>
        </div>
        {myShops.length > 1 ? (
          <div className="w-48">
            <label htmlFor="ws-shop" className="sr-only">
              店舗
            </label>
            <Select id="ws-shop" value={shopId} onChange={(e) => setShopId(e.target.value)}>
              {myShops.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      {!configured && q.data ? (
        <Alert tone="info" className="mb-4">
          勤務パターンが未設定のため、現在は店舗の営業時間に従って予約を受け付けています。
        </Alert>
      ) : null}
      {q.isLoading ? <InlineLoading /> : null}
      {rows.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {order.map((wd) => {
            const r = rows[wd]!;
            const update = (patch: Partial<DayRow>) =>
              setRows((xs) => xs.map((x, i) => (i === wd ? { ...x, ...patch } : x)));
            return (
              <li key={wd} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span
                  className={`w-6 text-[13px] font-semibold ${wd === 0 ? 'text-danger' : wd === 6 ? 'text-info' : ''}`}
                >
                  {WEEKDAYS_JA[wd]}
                </span>
                <div className="w-32">
                  <Switch
                    checked={r.on}
                    onChange={(v) => update({ on: v })}
                    label={r.on ? '出勤' : '休み'}
                    disabled={!editable}
                  />
                </div>
                {r.on ? (
                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`ws-s-${wd}`}>
                      {WEEKDAYS_JA[wd]}曜 開始
                    </label>
                    <Input
                      id={`ws-s-${wd}`}
                      type="time"
                      step={900}
                      inputSize="sm"
                      value={r.start}
                      onChange={(e) => update({ start: e.target.value })}
                      disabled={!editable}
                      className="w-28"
                    />
                    <span className="text-muted">〜</span>
                    <label className="sr-only" htmlFor={`ws-e-${wd}`}>
                      {WEEKDAYS_JA[wd]}曜 終了
                    </label>
                    <Input
                      id={`ws-e-${wd}`}
                      type="time"
                      step={900}
                      inputSize="sm"
                      value={r.end}
                      onChange={(e) => update({ end: e.target.value })}
                      disabled={!editable}
                      className="w-28"
                    />
                  </div>
                ) : null}
                {!defaults[wd]!.open ? <Badge size="sm">店休日</Badge> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-muted">
        ※
        すべて「休み」で保存すると未設定扱いとなり、営業時間に従います。特定日の休みは「シフト」画面で登録してください。
      </p>
      {editable ? (
        <div className="mt-4 flex justify-end">
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
