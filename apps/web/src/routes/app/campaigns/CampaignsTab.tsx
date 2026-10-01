import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CAMPAIGN_STATUS_LABEL,
  CHANNEL_LABEL,
  messagingApi,
  useSegments,
  useTemplates,
  type Campaign,
  type CampaignStatus,
  type Channel,
} from '../../../api/messaging';
import { ShareBar } from '../../../components/charts';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  InlineLoading,
  Input,
  KeyValue,
  Segmented,
  Select,
  TBody,
  THead,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
  type Tone,
} from '../../../components/ui';
import { newIdempotencyKey } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';
import { addDays, todayIn, zonedToIso } from '../../../lib/time';
import { SegmentBuilder, SegmentPreview } from './SegmentBuilder';
import { describeRule, newCondition, toRule, validateState, type BuilderState } from './segment-dsl';

const STATUS_TONE: Record<CampaignStatus, Tone> = {
  draft: 'neutral',
  scheduled: 'info',
  running: 'primary',
  completed: 'success',
  cancelled: 'outline',
  failed: 'danger',
};

/** S-53 一括配信: draft → approve → schedule (explicit) → running → completed / cancel */
export function CampaignsTab() {
  const { timezone: tz } = useAuth();
  const [status, setStatus] = useState<'' | CampaignStatus>('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['messaging', 'campaigns', { status }],
    queryFn: () => messagingApi.campaigns({ status: status || undefined, limit: 100 }),
    refetchInterval: (query) =>
      query.state.data?.items.some((c) => c.status === 'running' || c.status === 'scheduled') ? 10_000 : false,
  });
  const list = q.data?.items ?? [];

  return (
    <div className="space-y-4">
      <Alert tone="info" title="送信は明示的な「配信予約」操作のみ">
        キャンペーンは下書きとして保存されます。承認後に「配信予約」を押すまで、お客様へは一切送信されません。
        配信予約後もキャンセルすれば未送信分は取り消されます。
      </Alert>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="状態">
          <Select selectSize="sm" value={status} onChange={(e) => setStatus(e.target.value as '' | CampaignStatus)}>
            <option value="">すべて</option>
            {(Object.keys(CAMPAIGN_STATUS_LABEL) as CampaignStatus[]).map((s) => (
              <option key={s} value={s}>
                {CAMPAIGN_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          キャンペーンを作成
        </Button>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !list.length ? (
        <EmptyState
          icon="send"
          title="キャンペーンはまだありません"
          description="セグメントとメッセージを選んで、一括配信の下書きを作成できます。"
        />
      ) : null}
      {list.length ? (
        <Table caption="キャンペーン一覧">
          <THead>
            <Tr>
              <Th>名前</Th>
              <Th>状態</Th>
              <Th className="hidden md:table-cell">チャネル</Th>
              <Th className="hidden md:table-cell">配信日時</Th>
              <Th className="text-right">対象</Th>
              <Th className="hidden text-right sm:table-cell">送信済み</Th>
              <Th className="hidden text-right lg:table-cell">失敗</Th>
            </Tr>
          </THead>
          <TBody>
            {list.map((c) => (
              <Tr key={c.id} interactive onClick={() => setOpenId(c.id)}>
                <Td>
                  <button type="button" className="text-left font-medium hover:underline" onClick={() => setOpenId(c.id)}>
                    {c.name}
                  </button>
                  {c.status === 'draft' ? (
                    <p className="text-xs text-subtle">{c.approved_at ? '承認済み・未予約' : '未承認'}</p>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={STATUS_TONE[c.status]}>{CAMPAIGN_STATUS_LABEL[c.status]}</Badge>
                </Td>
                <Td className="hidden md:table-cell">{CHANNEL_LABEL[c.channel]}</Td>
                <Td className="hidden md:table-cell tabular">{c.scheduled_at ? formatDateTime(c.scheduled_at, tz) : '—'}</Td>
                <Td className="text-right tabular">{c.stats.targets ? c.stats.targets.toLocaleString('ja-JP') : '—'}</Td>
                <Td className="hidden text-right tabular sm:table-cell">{c.stats.sent.toLocaleString('ja-JP')}</Td>
                <Td className="hidden text-right tabular lg:table-cell">{c.stats.failed.toLocaleString('ja-JP')}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      {creating ? (
        <CreateCampaignDialog
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setOpenId(c.id);
          }}
        />
      ) : null}
      <CampaignDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function CreateCampaignDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Campaign) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId, me } = useAuth();
  const segments = useSegments();
  const templates = useTemplates({ status: 'active' });
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<Channel>('line');
  const [scope, setScope] = useState<'org' | 'shop'>(me?.allShops ? 'org' : 'shop');
  const [audience, setAudience] = useState<'saved' | 'custom'>('saved');
  const [segmentId, setSegmentId] = useState('');
  const [state, setState] = useState<BuilderState>({
    match: 'all',
    items: [newCondition('last_visit_days_gt'), newCondition('no_future_appointment')],
  });
  const [content, setContent] = useState<'template' | 'body'>('template');
  const [templateId, setTemplateId] = useState('');
  const [body, setBody] = useState('');
  const [key] = useState(newIdempotencyKey);

  const chTemplates = (templates.data ?? []).filter((t) => t.channel === channel && t.category !== 'transactional');
  const segList = segments.data?.items ?? [];
  const customErrors = audience === 'custom' ? validateState(state) : [];
  const valid =
    name.trim() &&
    (audience === 'saved' ? !!segmentId : !customErrors.length && !!toRule(state)) &&
    (content === 'template' ? !!templateId : !!body.trim());

  const create = useMutation({
    mutationFn: () =>
      messagingApi.createCampaign(
        {
          name: name.trim(),
          channel,
          shopId: scope === 'shop' ? currentShopId : null,
          ...(audience === 'saved' ? { segmentId } : { segmentRule: toRule(state)! }),
          ...(content === 'template' ? { templateId } : { body: body.trim() }),
        },
        key,
      ),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['messaging', 'campaigns'] });
      toast.success('キャンペーンを下書き保存しました', 'まだ送信されていません');
      onCreated(c);
    },
    onError: (e) => toast.error(e),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title="キャンペーンを作成（下書き）"
      description="保存しても送信はされません。内容を確認・承認してから配信予約してください。"
      dismissable={!create.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!valid}>
            下書きを保存
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="キャンペーン名" required className="sm:col-span-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="例: 10月 休眠フォロー" />
          </Field>
          <Field label="チャネル">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="配信対象の店舗" hint="全店舗向けには全店舗権限が必要です">
            <Select value={scope} onChange={(e) => setScope(e.target.value as 'org' | 'shop')}>
              <option value="org">全店舗</option>
              <option value="shop">この店舗の顧客のみ</option>
            </Select>
          </Field>
        </div>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold">配信対象</h3>
            <Segmented
              size="sm"
              label="配信対象の指定方法"
              value={audience}
              onChange={setAudience}
              options={[
                { value: 'saved', label: '保存済みセグメント' },
                { value: 'custom', label: '条件を指定' },
              ]}
            />
          </div>
          {audience === 'saved' ? (
            <Field label="セグメント" required hint={segList.length ? undefined : 'セグメントタブで作成できます'}>
              <Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
                <option value="">選択してください</option>
                {segList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
              <SegmentBuilder value={state} onChange={setState} />
              <SegmentPreview compact state={state} shopId={scope === 'shop' ? (currentShopId ?? undefined) : undefined} />
            </div>
          )}
          {audience === 'saved' && segmentId ? (
            <p className="text-xs text-muted">条件: {describeRule(segList.find((s) => s.id === segmentId)?.rule)}</p>
          ) : null}
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold">メッセージ</h3>
            <Segmented
              size="sm"
              label="メッセージの指定方法"
              value={content}
              onChange={setContent}
              options={[
                { value: 'template', label: 'テンプレート' },
                { value: 'body', label: '本文を入力' },
              ]}
            />
          </div>
          {content === 'template' ? (
            <Field label="テンプレート" required>
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">選択してください</option>
                {chTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="本文" required hint="{{customer.name}} などの変数はお客様ごとに置き換わります">
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={5000} />
            </Field>
          )}
          {content === 'template' && templateId ? (
            <p className="whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
              {chTemplates.find((t) => t.id === templateId)?.body}
            </p>
          ) : null}
        </section>
      </div>
    </Dialog>
  );
}

function CampaignDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const q = useQuery({
    queryKey: ['messaging', 'campaign', id],
    queryFn: () => messagingApi.campaign(id!),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.status === 'running' || query.state.data?.status === 'scheduled' ? 5_000 : false),
  });
  const c = q.data;
  const [scheduling, setScheduling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['messaging', 'campaigns'] });
    void qc.invalidateQueries({ queryKey: ['messaging', 'campaign', id] });
  };
  const approve = useMutation({
    mutationFn: () => messagingApi.approveCampaign(id!),
    onSuccess: () => {
      refresh();
      toast.success('承認しました', '配信するには「配信予約」を行ってください');
    },
    onError: (e) => toast.error(e),
  });
  const cancel = useMutation({
    mutationFn: () => messagingApi.cancelCampaign(id!),
    onSuccess: (r) => {
      refresh();
      setConfirmCancel(false);
      toast.success('キャンペーンをキャンセルしました', r.cancelledMessages ? `未送信 ${r.cancelledMessages}件を取り消しました` : undefined);
    },
    onError: (e) => toast.error(e),
  });
  const del = useMutation({
    mutationFn: () => messagingApi.deleteCampaign(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messaging', 'campaigns'] });
      setConfirmDelete(false);
      toast.success('下書きを削除しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width="lg"
      title={c?.name ?? 'キャンペーン'}
      description={c ? <Badge tone={STATUS_TONE[c.status]}>{CAMPAIGN_STATUS_LABEL[c.status]}</Badge> : undefined}
      footer={
        c ? (
          <>
            {c.status === 'draft' ? (
              <Button variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>
                削除
              </Button>
            ) : null}
            {['draft', 'scheduled', 'running'].includes(c.status) ? (
              <Button variant="secondary" onClick={() => setConfirmCancel(true)}>
                {c.status === 'draft' ? '中止する' : '配信をキャンセル'}
              </Button>
            ) : null}
            {c.status === 'draft' && !c.approved_at ? (
              <Button icon="check" onClick={() => approve.mutate()} loading={approve.isPending}>
                承認する
              </Button>
            ) : null}
            {c.status === 'draft' ? (
              <Button variant="primary" icon="send" onClick={() => setScheduling(true)}>
                配信予約…
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {c ? (
        <div className="space-y-5">
          {c.status === 'draft' ? (
            <Alert tone="info">
              下書きです。{c.approved_at ? '承認済みです。' : '承認後、'}「配信予約」を押すまで送信されません。
            </Alert>
          ) : null}
          <KeyValue
            items={[
              { label: 'チャネル', value: CHANNEL_LABEL[c.channel] },
              { label: '配信対象', value: describeRule(c.segment_rule) },
              { label: 'メッセージ', value: c.template_id ? 'テンプレート' : <span className="whitespace-pre-wrap">{c.body}</span> },
              { label: '承認', value: c.approved_at ? formatDateTime(c.approved_at, tz) : '未承認' },
              { label: '配信日時', value: c.scheduled_at ? formatDateTime(c.scheduled_at, tz) : '—' },
              { label: '開始 / 完了', value: `${c.started_at ? formatDateTime(c.started_at, tz) : '—'} / ${c.completed_at ? formatDateTime(c.completed_at, tz) : '—'}` },
              { label: '作成', value: formatDateTime(c.created_at, tz) },
            ]}
          />
          {c.status !== 'draft' && c.status !== 'scheduled' ? (
            <section className="space-y-3">
              <h3 className="text-[15px] font-semibold">配信結果</h3>
              <dl className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                {(
                  [
                    ['対象', c.stats.targets],
                    ['送信済み', c.stats.sent],
                    ['待機', c.stats.queued],
                    ['失敗', c.stats.failed],
                    ['スキップ', c.stats.skipped],
                    ['取消', c.stats.cancelled],
                  ] as const
                ).map(([label, n]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className="text-lg font-semibold">{n.toLocaleString('ja-JP')}</dd>
                  </div>
                ))}
              </dl>
              <ShareBar
                ariaLabel="配信結果の内訳"
                valueFormat={(n) => `${n.toLocaleString('ja-JP')}件`}
                parts={[
                  { key: 'sent', label: '送信済み', value: c.stats.sent },
                  { key: 'queued', label: '待機', value: c.stats.queued },
                  { key: 'skipped', label: 'スキップ（同意なし等）', value: c.stats.skipped },
                  { key: 'failed', label: '失敗', value: c.stats.failed },
                  { key: 'cancelled', label: '取消', value: c.stats.cancelled },
                ]}
              />
            </section>
          ) : null}
        </div>
      ) : null}
      {c && scheduling ? <ScheduleDialog campaign={c} onClose={() => setScheduling(false)} onDone={refresh} /> : null}
      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="キャンペーンをキャンセルしますか？"
        description="未送信のメッセージはすべて取り消されます。送信済みのメッセージは取り消せません。"
        tone="danger"
        confirmLabel="キャンセルする"
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="下書きを削除しますか？"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </Drawer>
  );
}

/** The ONLY place a campaign is sent: explicit schedule with target count confirmation */
function ScheduleDialog({ campaign, onClose, onDone }: { campaign: Campaign; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const [when, setWhen] = useState<'now' | 'later'>('later');
  const [date, setDate] = useState(addDays(todayIn(tz), 1));
  const [time, setTime] = useState('10:00');
  const [ack, setAck] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const count = useQuery({
    queryKey: ['messaging', 'campaign-count', campaign.id],
    queryFn: () =>
      messagingApi.previewSegment({ rule: campaign.segment_rule, shopId: campaign.shop_id ?? undefined, sampleSize: 0 }),
  });
  const schedule = useMutation({
    mutationFn: () => messagingApi.scheduleCampaign(campaign.id, when === 'now' ? undefined : zonedToIso(date, time, tz), key),
    onSuccess: () => {
      onDone();
      toast.success(when === 'now' ? '配信を開始しました' : '配信を予約しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="配信予約"
      description="この操作でお客様へのメッセージ送信が確定します。"
      dismissable={!schedule.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={schedule.isPending}>
            やめる
          </Button>
          <Button variant="primary" icon="send" onClick={() => schedule.mutate()} loading={schedule.isPending} disabled={!ack}>
            {when === 'now' ? '今すぐ配信する' : '配信を予約する'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-surface-2 p-4">
          <p className="text-xs text-muted">現在の対象人数（配信時点で再計算されます）</p>
          <p className="mt-1 text-2xl font-semibold">{count.data ? `${count.data.count.toLocaleString('ja-JP')}人` : '…'}</p>
          <p className="mt-1 text-xs text-subtle">配信許可・チャネルの同意がないお客様、深夜帯はスキップ/延期されます。</p>
        </div>
        <Segmented
          label="配信タイミング"
          value={when}
          onChange={setWhen}
          options={[
            { value: 'later', label: '日時を指定' },
            { value: 'now', label: '今すぐ' },
          ]}
        />
        {when === 'later' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="配信日">
              <Input type="date" value={date} min={todayIn(tz)} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="時刻">
              <Input type="time" value={time} step={900} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>
        ) : null}
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--primary)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>内容と配信対象を確認しました。{CHANNEL_LABEL[campaign.channel]}で送信することに同意します。</span>
        </label>
      </div>
    </Dialog>
  );
}
