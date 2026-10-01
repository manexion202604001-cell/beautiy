import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CHANNEL_LABEL,
  TRIGGER_LABEL,
  messagingApi,
  messagingKeys,
  useTemplates,
  type Automation,
  type AutomationConfig,
  type Channel,
  type DryRunResult,
  type TriggerType,
} from '../../../api/messaging';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InlineLoading,
  Input,
  Select,
  Switch,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { formatDate, formatDateTime } from '../../../lib/format';
import { SegmentBuilder } from './SegmentBuilder';
import { describeRule, emptyState, fromRule, toRule, validateState, type BuilderState } from './segment-dsl';

const TRIGGERS = Object.keys(TRIGGER_LABEL) as TriggerType[];
const DEFAULT_DAYS: Partial<Record<TriggerType, number>> = {
  days_since_last_visit: 45,
  no_return_after_first_visit: 60,
  after_visit: 3,
};

function describeConfig(trigger: TriggerType, cfg: AutomationConfig): string {
  const parts: string[] = [];
  const days = cfg.days ?? DEFAULT_DAYS[trigger];
  if (trigger === 'days_since_last_visit') parts.push(`最終来店から${days}日経過`);
  if (trigger === 'no_return_after_first_visit') parts.push(`初回来店から${days}日・再来なし`);
  if (trigger === 'after_visit') parts.push(`来店の${days}日後`);
  if (trigger === 'visit_cycle_due') {
    const off = cfg.offsetDays ?? 0;
    parts.push(`来店周期${off === 0 ? 'ちょうど' : off > 0 ? `の${off}日後` : `の${-off}日前`}（来店${cfg.minVisits ?? 2}回以上）`);
  }
  if (trigger === 'birthday_month') parts.push('誕生月に1回');
  if (trigger === 'after_visit' ? cfg.requireNoFutureAppointment === true : trigger !== 'birthday_month' && cfg.requireNoFutureAppointment !== false)
    parts.push('次回予約なしのみ');
  if (cfg.sendHour !== undefined) parts.push(`${cfg.sendHour}時に送信`);
  if (cfg.segmentRule) parts.push(`追加条件: ${describeRule(cfg.segmentRule)}`);
  return parts.join(' ・ ');
}

/** S-54 自動配信: 休眠/初回未再来/来店周期/来店後/誕生月 — evaluated daily at 10:00 when enabled */
export function AutomationsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { timezone: tz } = useAuth();
  const q = useQuery({ queryKey: messagingKeys.automations, queryFn: messagingApi.automations });
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [enabling, setEnabling] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [dry, setDry] = useState<{ a: Automation; r: DryRunResult } | null>(null);

  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => messagingApi.updateAutomation(id, { isActive: on }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: messagingKeys.automations });
      setEnabling(null);
      toast.success(a.is_active ? '自動配信を有効にしました' : '自動配信を停止しました');
    },
    onError: (e) => toast.error(e),
  });
  const dryRun = useMutation({
    mutationFn: (a: Automation) => messagingApi.dryRun(a.id).then((r) => ({ a, r })),
    onSuccess: setDry,
    onError: (e) => toast.error(e),
  });
  const del = useMutation({
    mutationFn: (id: string) => messagingApi.deleteAutomation(id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: messagingKeys.automations });
      setDeleting(null);
      toast.success(r?.deactivatedOnly ? '送信履歴があるため停止のみ行いました' : '自動配信を削除しました');
    },
    onError: (e) => toast.error(e),
  });

  return (
    <div className="space-y-4">
      <Alert tone="info" title="自動配信は「有効」にしたものだけが動きます">
        有効な自動配信は毎日10:00（JST）に対象者を判定し、同じ来店サイクルで重複送信しないよう記録します。
        作成直後は停止状態です。「試算」で送信せずに対象人数を確認できます。
      </Alert>
      <div className="flex justify-end">
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          自動配信を作成
        </Button>
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? (
        <EmptyState icon="clock" title="自動配信はまだありません" description="休眠フォローや誕生月メッセージを自動化できます。" />
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {(q.data ?? []).map((a) => (
          <Card key={a.id} className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{a.name}</p>
                <p className="text-xs text-muted">{TRIGGER_LABEL[a.trigger_type]}</p>
              </div>
              <Switch
                label={<span className="sr-only">{a.name}を有効にする</span>}
                checked={a.is_active}
                onChange={(on) => (on ? setEnabling(a) : toggle.mutate({ id: a.id, on: false }))}
                disabled={toggle.isPending}
              />
            </div>
            <p className="text-[13px] text-fg">{describeConfig(a.trigger_type, a.config ?? {})}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone={a.is_active ? 'success' : 'neutral'} dot>
                {a.is_active ? '有効' : '停止中'}
              </Badge>
              <span>{CHANNEL_LABEL[a.channel]}</span>
              <span>・{a.template_id ? '独自テンプレート' : '標準テンプレート'}</span>
              <span>・最終実行 {a.last_run_at ? formatDateTime(a.last_run_at, tz) : '—'}</span>
            </div>
            <div className="mt-auto flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              <Button size="sm" icon="search" onClick={() => dryRun.mutate(a)} loading={dryRun.isPending && dryRun.variables?.id === a.id}>
                試算（送信しない）
              </Button>
              <IconButton icon="edit" label="編集" size="sm" variant="secondary" onClick={() => setEditing(a)} />
              <IconButton icon="trash" label="削除" size="sm" variant="secondary" onClick={() => setDeleting(a)} />
            </div>
          </Card>
        ))}
      </div>
      {editing ? <AutomationDialog automation={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={!!enabling}
        onClose={() => setEnabling(null)}
        title="自動配信を有効にしますか？"
        description="有効にすると、毎日10:00に条件に合うお客様へ自動でメッセージが送信されます。事前に「試算」で対象人数を確認することをおすすめします。"
        confirmLabel="有効にする"
        loading={toggle.isPending}
        onConfirm={() => enabling && toggle.mutate({ id: enabling.id, on: true })}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="自動配信を削除しますか？"
        description="送信履歴がある場合は、重複送信防止の記録を残すため停止のみ行います。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
      <Dialog
        open={!!dry}
        onClose={() => setDry(null)}
        title="試算結果（送信していません）"
        description={dry?.a.name}
        footer={<Button onClick={() => setDry(null)}>閉じる</Button>}
      >
        {dry ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-surface-2 p-3">
                <p className="text-xs text-muted">今実行した場合の送信対象</p>
                <p className="text-2xl font-semibold" data-testid="dry-run-count">
                  {dry.r.candidates.toLocaleString('ja-JP')}人
                </p>
              </div>
              <div className="rounded-xl bg-surface-2 p-3">
                <p className="text-xs text-muted">同じサイクルで送信済み</p>
                <p className="text-2xl font-semibold">{dry.r.alreadySent.toLocaleString('ja-JP')}人</p>
              </div>
            </div>
            {dry.r.sample.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border text-[13px]">
                {dry.r.sample.map((s) => (
                  <li key={s.id} className="flex justify-between gap-2 px-3 py-2">
                    <span className="truncate">{s.display_name || '（氏名未登録）'}</span>
                    <span className="shrink-0 text-xs text-muted">
                      最終来店 {s.last_visit_at ? formatDate(s.last_visit_at, tz, { weekday: false }) : '—'} ・{s.visit_count}回
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted">配信許可（marketing opt-in）のあるお客様のみが対象です。</p>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function AutomationDialog({ automation, onClose }: { automation: Automation | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId, me } = useAuth();
  const templates = useTemplates({ status: 'active' });
  const cfg = automation?.config ?? {};
  const [name, setName] = useState(automation?.name ?? '');
  const [trigger, setTrigger] = useState<TriggerType>(automation?.trigger_type ?? 'days_since_last_visit');
  const [days, setDays] = useState<number | undefined>(cfg.days ?? DEFAULT_DAYS[automation?.trigger_type ?? 'days_since_last_visit']);
  const [offsetDays, setOffsetDays] = useState<number | undefined>(cfg.offsetDays ?? 0);
  const [minVisits, setMinVisits] = useState<number | undefined>(cfg.minVisits ?? 2);
  const [noFuture, setNoFuture] = useState(cfg.requireNoFutureAppointment ?? (automation?.trigger_type !== 'after_visit'));
  const [sendHour, setSendHour] = useState<string>(cfg.sendHour !== undefined ? String(cfg.sendHour) : '');
  const [channel, setChannel] = useState<Channel>(automation?.channel ?? 'line');
  const [templateId, setTemplateId] = useState(automation?.template_id ?? '');
  const [scope, setScope] = useState<'org' | 'shop'>(automation ? (automation.shop_id ? 'shop' : 'org') : me?.allShops ? 'org' : 'shop');
  const initialSeg = cfg.segmentRule ? fromRule(cfg.segmentRule) : null;
  const [useSeg, setUseSeg] = useState(!!cfg.segmentRule);
  const [seg, setSeg] = useState<BuilderState>(initialSeg ?? emptyState());

  const chTemplates = (templates.data ?? []).filter((t) => t.channel === channel && t.category !== 'transactional');
  const usesDays = trigger === 'days_since_last_visit' || trigger === 'no_return_after_first_visit' || trigger === 'after_visit';
  const segErrors = useSeg ? validateState(seg) : [];

  const buildConfig = (): AutomationConfig => {
    const c: AutomationConfig = {};
    if (usesDays && days !== undefined) c.days = days;
    if (trigger === 'visit_cycle_due') {
      c.offsetDays = offsetDays ?? 0;
      c.minVisits = minVisits ?? 2;
    }
    if (trigger !== 'birthday_month') c.requireNoFutureAppointment = noFuture;
    if (sendHour) c.sendHour = Number(sendHour);
    if (cfg.templateKey) c.templateKey = cfg.templateKey;
    const rule = useSeg ? toRule(seg) : null;
    if (rule) c.segmentRule = rule;
    return c;
  };

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: name.trim(),
        config: buildConfig(),
        channel,
        templateId: templateId || null,
        shopId: scope === 'shop' ? currentShopId : null,
      };
      if (automation) {
        // only send the scope when it changed (PATCH semantics; org scope needs all-shop access)
        const { shopId: _shopId, ...rest } = common;
        const changed = (automation.shop_id ? 'shop' : 'org') !== scope;
        return messagingApi.updateAutomation(automation.id, changed ? common : rest);
      }
      return messagingApi.createAutomation({ ...common, triggerType: trigger, isActive: false });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: messagingKeys.automations });
      toast.success(automation ? '自動配信を更新しました' : '自動配信を作成しました（停止中）');
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const valid = name.trim() && (!usesDays || (days !== undefined && days >= 1)) && !segErrors.length;

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={automation ? '自動配信を編集' : '自動配信を作成'}
      dismissable={!save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="名前" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="例: 休眠45日フォロー" />
          </Field>
          <Field label="きっかけ" hint={automation ? '作成後は変更できません' : undefined}>
            <Select
              value={trigger}
              onChange={(e) => {
                const t = e.target.value as TriggerType;
                setTrigger(t);
                setDays(DEFAULT_DAYS[t]);
                setNoFuture(t !== 'after_visit');
              }}
              disabled={!!automation}
            >
              {TRIGGERS.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          {usesDays ? (
            <Field label={trigger === 'after_visit' ? '来店から何日後' : trigger === 'no_return_after_first_visit' ? '初回来店から何日' : '最終来店から何日'} required>
              <Input type="number" min={1} max={3650} value={days ?? ''} onChange={(e) => setDays(e.target.value === '' ? undefined : Number(e.target.value))} />
            </Field>
          ) : null}
          {trigger === 'visit_cycle_due' ? (
            <>
              <Field label="周期からのずれ（日）" hint="正の値=予定日の後、負の値=予定日の前">
                <Input type="number" min={-60} max={365} value={offsetDays ?? ''} onChange={(e) => setOffsetDays(e.target.value === '' ? undefined : Number(e.target.value))} />
              </Field>
              <Field label="対象の最低来店回数">
                <Input type="number" min={2} max={100} value={minVisits ?? ''} onChange={(e) => setMinVisits(e.target.value === '' ? undefined : Number(e.target.value))} />
              </Field>
            </>
          ) : null}
          <Field label="送信時刻" hint="未指定なら毎日10:00の判定時にすぐ送信">
            <Select value={sendHour} onChange={(e) => setSendHour(e.target.value)}>
              <option value="">判定時にすぐ</option>
              {Array.from({ length: 12 }, (_, i) => i + 9).map((h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </Select>
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
          <Field label="テンプレート" hint="未指定ならきっかけに応じた標準テンプレート">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">標準テンプレート</option>
              {chTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="対象店舗" hint="全店舗向けには全店舗権限が必要です">
            <Select value={scope} onChange={(e) => setScope(e.target.value as 'org' | 'shop')}>
              <option value="org">全店舗</option>
              <option value="shop">この店舗の顧客のみ</option>
            </Select>
          </Field>
        </div>
        {trigger !== 'birthday_month' ? (
          <Checkbox label="次回予約がないお客様のみ" checked={noFuture} onChange={(e) => setNoFuture(e.target.checked)} />
        ) : null}
        <div className="space-y-3 rounded-xl border border-border p-3">
          <Checkbox
            label="セグメント条件で対象をさらに絞り込む"
            checked={useSeg}
            onChange={(e) => setUseSeg(e.target.checked)}
          />
          {useSeg ? <SegmentBuilder value={seg} onChange={setSeg} /> : null}
          {useSeg && segErrors.length ? <p className="text-xs text-danger">{segErrors[0]}</p> : null}
        </div>
      </div>
    </Dialog>
  );
}
