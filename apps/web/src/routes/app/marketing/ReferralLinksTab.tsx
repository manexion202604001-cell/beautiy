import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  TARGET_LABEL,
  marketingApi,
  useReferralLinks,
  useReferralStats,
  type ReferralLink,
  type ReferralTarget,
} from '../../../api/marketing';
import { useStaffList } from '../../../api/org';
import { copyText, QrCode } from '../../../components/QrCode';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineLoading,
  Input,
  LoadMore,
  Segmented,
  Select,
  Switch,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
  useToast,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDate, formatYen } from '../../../lib/format';

/** S-61 紹介・計測リンク: short links with UTM, click/booking/purchase/revenue stats, copy + QR */
export function ReferralLinksTab() {
  const { timezone: tz, shops } = useAuth();
  const [active, setActive] = useState<'active' | 'all'>('active');
  const q = useReferralLinks({ active: active === 'active' ? true : undefined });
  const staff = useStaffList();
  const [editing, setEditing] = useState<ReferralLink | 'new' | null>(null);
  const [openId, setOpenId] = useState<ReferralLink | null>(null);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const staffName = (id: string | null) => (id ? (staff.data?.find((s) => s.id === id)?.display_name ?? '') : '');
  const shopName = (id: string | null) => (id ? (shops.find((s) => s.id === id)?.name ?? '') : '全店舗');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Segmented
          size="sm"
          label="表示するリンク"
          value={active}
          onChange={setActive}
          options={[
            { value: 'active', label: '有効のみ' },
            { value: 'all', label: 'すべて' },
          ]}
        />
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          リンクを作成
        </Button>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !items.length ? (
        <EmptyState icon="external" title="紹介リンクはまだありません" description="SNSやチラシ用の計測付きリンクを発行できます。" />
      ) : null}
      {items.length ? (
        <Table caption="紹介リンク">
          <THead>
            <Tr>
              <Th>名前</Th>
              <Th className="hidden md:table-cell">リンク先</Th>
              <Th className="hidden lg:table-cell">UTM</Th>
              <Th className="text-right">クリック</Th>
              <Th className="text-right">予約</Th>
              <Th className="hidden text-right sm:table-cell">購入</Th>
              <Th className="w-28">
                <span className="sr-only">操作</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((l) => (
              <Tr key={l.id}>
                <Td>
                  <button type="button" className="text-left font-medium hover:underline" onClick={() => setOpenId(l)}>
                    {l.name}
                  </button>
                  <p className="text-xs text-subtle">
                    <code>{l.code}</code> ・{shopName(l.shop_id)}
                    {l.staff_id ? ` ・${staffName(l.staff_id)}` : ''}
                    {l.customer_id ? ' ・お友達紹介' : ''}
                    {!l.is_active ? ' ・無効' : ''}
                  </p>
                </Td>
                <Td className="hidden md:table-cell">{TARGET_LABEL[l.target]}</Td>
                <Td className="hidden text-xs text-muted lg:table-cell">
                  {[l.utm?.source, l.utm?.medium, l.utm?.campaign].filter(Boolean).join(' / ') || '—'}
                </Td>
                <Td className="text-right tabular">{l.click_count.toLocaleString('ja-JP')}</Td>
                <Td className="text-right tabular">{(l.booking_count ?? 0).toLocaleString('ja-JP')}</Td>
                <Td className="hidden text-right tabular sm:table-cell">{(l.purchase_count ?? 0).toLocaleString('ja-JP')}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <CopyButton url={l.url} />
                    <IconButton icon="chart" label="統計とQRコード" size="sm" onClick={() => setOpenId(l)} />
                    <IconButton icon="edit" label="編集" size="sm" onClick={() => setEditing(l)} />
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMore hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
      {editing ? <LinkDialog link={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <LinkDrawer link={openId} onClose={() => setOpenId(null)} tz={tz} />
    </div>
  );
}

function CopyButton({ url }: { url: string }) {
  const toast = useToast();
  return (
    <IconButton
      icon="copy"
      label="リンクをコピー"
      size="sm"
      onClick={() => void copyText(url).then((ok) => (ok ? toast.success('リンクをコピーしました') : toast.error('コピーできませんでした')))}
    />
  );
}

function LinkDrawer({ link, onClose, tz }: { link: ReferralLink | null; onClose: () => void; tz: string }) {
  const stats = useReferralStats(link?.id ?? null);
  const toast = useToast();
  return (
    <Drawer open={!!link} onClose={onClose} title={link?.name ?? ''} description={link ? `作成 ${formatDate(link.created_at, tz)}` : undefined}>
      {link ? (
        <div className="space-y-5">
          <div className="flex flex-col items-center gap-3">
            <QrCode value={link.url} label={`${link.name}のQRコード`} />
            <div className="flex w-full gap-2">
              <Input readOnly value={link.url} aria-label="リンクURL" onFocus={(e) => e.currentTarget.select()} />
              <Button
                icon="copy"
                onClick={() => void copyText(link.url).then((ok) => (ok ? toast.success('リンクをコピーしました') : toast.error('コピーできませんでした')))}
              >
                コピー
              </Button>
            </div>
          </div>
          {stats.isLoading ? <InlineLoading /> : null}
          {stats.error ? <ErrorState error={stats.error} /> : null}
          {stats.data ? (
            <dl className="grid grid-cols-2 gap-3" data-testid="referral-stats">
              {(
                [
                  ['クリック', `${stats.data.clicks.toLocaleString('ja-JP')}回`],
                  ['予約', `${stats.data.bookings.toLocaleString('ja-JP')}件`],
                  ['来店', `${stats.data.completedVisits.toLocaleString('ja-JP')}件`],
                  ['購入', `${stats.data.purchases.toLocaleString('ja-JP')}件`],
                  ['売上（来店+購入）', formatYen(stats.data.revenue)],
                  ['予約率', stats.data.conversionRate === null ? '—' : `${(stats.data.conversionRate * 100).toFixed(1)}%`],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border p-3">
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="mt-0.5 text-lg font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="text-xs text-muted">クリックはボット・プレビューを除外して計測します。売上は紹介経由の来店会計とEC購入の合計です。</p>
        </div>
      ) : null}
    </Drawer>
  );
}

function LinkDialog({ link, onClose }: { link: ReferralLink | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { shops, currentShopId } = useAuth();
  const staff = useStaffList();
  const [name, setName] = useState(link?.name ?? '');
  const [target, setTarget] = useState<ReferralTarget>(link?.target ?? 'booking');
  const [shopId, setShopId] = useState(link ? (link.shop_id ?? '') : (currentShopId ?? ''));
  const [staffId, setStaffId] = useState(link?.staff_id ?? '');
  const [utm, setUtm] = useState({ source: link?.utm?.source ?? '', medium: link?.utm?.medium ?? '', campaign: link?.utm?.campaign ?? '' });
  const [isActive, setIsActive] = useState(link?.is_active ?? true);
  const [deleting, setDeleting] = useState(false);
  const [key] = useState(newIdempotencyKey);

  const utmClean = Object.fromEntries(Object.entries(utm).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
  const save = useMutation({
    mutationFn: () =>
      link
        ? marketingApi.updateLink(link.id, { name: name.trim(), shopId: shopId || null, staffId: staffId || null, utm: utmClean, isActive })
        : marketingApi.createLink({ name: name.trim(), target, shopId: shopId || null, staffId: staffId || null, utm: utmClean }, key),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing', 'links'] });
      toast.success(link ? 'リンクを更新しました' : 'リンクを作成しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  const del = useMutation({
    mutationFn: () => marketingApi.deleteLink(link!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['marketing', 'links'] });
      toast.success('リンクを削除しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={link ? '紹介リンクを編集' : '紹介リンクを作成'}
      description={link ? `コード ${link.code}（変更できません）` : '短縮コードは自動で発行されます。'}
      dismissable={!save.isPending}
      footer={
        <>
          {link ? (
            <Button variant="ghost" icon="trash" className="mr-auto text-danger!" onClick={() => setDeleting(true)}>
              削除
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="名前" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="例: Instagram プロフィール" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="リンク先" hint={link ? '作成後は変更できません' : undefined}>
            <Select value={target} onChange={(e) => setTarget(e.target.value as ReferralTarget)} disabled={!!link}>
              {(['booking', 'profile'] as ReferralTarget[]).map((t) => (
                <option key={t} value={t}>
                  {TARGET_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="店舗">
            <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
              <option value="">指定なし</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="スタッフ（紹介者）" optional>
            <Select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
              <option value="">指定なし</option>
              {(staff.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-3">
          <legend className="mb-1 text-[13px] font-medium">計測パラメータ（UTM）</legend>
          <Field label="source">
            <Input value={utm.source} onChange={(e) => setUtm({ ...utm, source: e.target.value })} placeholder="instagram" maxLength={100} />
          </Field>
          <Field label="medium">
            <Input value={utm.medium} onChange={(e) => setUtm({ ...utm, medium: e.target.value })} placeholder="social" maxLength={100} />
          </Field>
          <Field label="campaign">
            <Input value={utm.campaign} onChange={(e) => setUtm({ ...utm, campaign: e.target.value })} placeholder="autumn2026" maxLength={100} />
          </Field>
        </fieldset>
        {link ? <Switch checked={isActive} onChange={setIsActive} label="有効" description="無効にすると、このリンク・QRコードは開けなくなります（計測も停止）。" /> : null}
        {link ? <Badge tone="outline">{link.url}</Badge> : null}
      </div>
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="リンクを削除しますか？"
        description="配布済みのQRコードやURLは無効になります。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </Dialog>
  );
}
