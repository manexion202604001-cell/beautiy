import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { useMenus } from '../../../api/catalog';
import { useTags } from '../../../api/customers';
import { messagingApi } from '../../../api/messaging';
import { useStaffList } from '../../../api/org';
import {
  Alert,
  Button,
  Checkbox,
  IconButton,
  Input,
  InlineLoading,
  Select,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cn } from '../../../lib/cn';
import { formatDate, formatYen } from '../../../lib/format';
import { useDebounced } from '../../../lib/hooks';
import {
  CONDITION_TYPES,
  defaultCondition,
  newCondition,
  newGroup,
  toRule,
  validateCondition,
  validateState,
  type BuilderCondition,
  type BuilderGroup,
  type BuilderState,
  type ConditionType,
  type Match,
  type SegmentCondition,
} from './segment-dsl';

/** Visual editor for the segment rule DSL (all/any groups, one nesting level, NOT per condition) */
export function SegmentBuilder({
  value,
  onChange,
  disabled,
}: {
  value: BuilderState;
  onChange: (s: BuilderState) => void;
  disabled?: boolean;
}) {
  const setItem = (id: string, next: BuilderCondition | BuilderGroup | null) =>
    onChange({
      ...value,
      items: next
        ? value.items.map((i) => (i.id === id ? next : i))
        : value.items.filter((i) => i.id !== id),
    });

  return (
    <div className="space-y-3" data-testid="segment-builder">
      <MatchPicker
        label="条件の組み合わせ"
        value={value.match}
        onChange={(m) => onChange({ ...value, match: m })}
        disabled={disabled}
      />
      {value.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted">
          条件を追加してください。条件なしでは対象者を決められません。
        </p>
      ) : null}
      <ol className="space-y-2">
        {value.items.map((item, idx) => (
          <li key={item.id}>
            {idx > 0 ? <Joiner match={value.match} /> : null}
            {item.kind === 'condition' ? (
              <ConditionRow c={item} onChange={(n) => setItem(item.id, n)} onRemove={() => setItem(item.id, null)} disabled={disabled} />
            ) : (
              <GroupBox g={item} onChange={(n) => setItem(item.id, n)} onRemove={() => setItem(item.id, null)} disabled={disabled} />
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <AddConditionSelect
          onAdd={(t) => onChange({ ...value, items: [...value.items, newCondition(t)] })}
          disabled={disabled}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="layers"
          onClick={() => onChange({ ...value, items: [...value.items, newGroup(value.match === 'all' ? 'any' : 'all')] })}
          disabled={disabled}
        >
          グループを追加
        </Button>
      </div>
    </div>
  );
}

function Joiner({ match }: { match: Match }) {
  return (
    <div className="flex items-center gap-2 py-1 pl-4 text-[11px] font-semibold text-subtle" aria-hidden>
      <span className="h-3 w-px bg-border-strong" />
      {match === 'all' ? 'かつ' : 'または'}
    </div>
  );
}

function MatchPicker({
  label,
  value,
  onChange,
  disabled,
  compact,
}: {
  label: string;
  value: Match;
  onChange: (m: Match) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 text-[13px]', compact && 'text-xs')}>
      <span className="text-muted">次の条件の</span>
      <Select
        selectSize="sm"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as Match)}
        disabled={disabled}
        className="w-auto!"
      >
        <option value="all">すべてに一致（AND）</option>
        <option value="any">いずれかに一致（OR）</option>
      </Select>
    </div>
  );
}

function AddConditionSelect({ onAdd, disabled, small }: { onAdd: (t: ConditionType) => void; disabled?: boolean; small?: boolean }) {
  return (
    <Select
      selectSize="sm"
      aria-label="条件を追加"
      value=""
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value as ConditionType);
      }}
      disabled={disabled}
      className={cn('w-auto font-medium text-primary', small && 'text-xs')}
    >
      <option value="">＋ 条件を追加</option>
      {CONDITION_TYPES.map((c) => (
        <option key={c.type} value={c.type}>
          {c.label}
        </option>
      ))}
    </Select>
  );
}

function GroupBox({
  g,
  onChange,
  onRemove,
  disabled,
}: {
  g: BuilderGroup;
  onChange: (g: BuilderGroup) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const setCond = (id: string, next: BuilderCondition | null) =>
    onChange({
      ...g,
      conditions: next ? g.conditions.map((c) => (c.id === id ? next : c)) : g.conditions.filter((c) => c.id !== id),
    });
  return (
    <fieldset className="rounded-xl border border-border-strong/70 bg-surface-2/50 p-3">
      <legend className="sr-only">条件グループ</legend>
      <div className="mb-2 flex items-center justify-between gap-2">
        <MatchPicker label="グループ内の組み合わせ" value={g.match} onChange={(m) => onChange({ ...g, match: m })} disabled={disabled} compact />
        <IconButton icon="trash" label="グループを削除" size="sm" onClick={onRemove} disabled={disabled} />
      </div>
      <ol className="space-y-2">
        {g.conditions.map((c, idx) => (
          <li key={c.id}>
            {idx > 0 ? <Joiner match={g.match} /> : null}
            <ConditionRow c={c} onChange={(n) => setCond(c.id, n)} onRemove={() => setCond(c.id, null)} disabled={disabled} />
          </li>
        ))}
      </ol>
      <div className="mt-2">
        <AddConditionSelect small onAdd={(t) => onChange({ ...g, conditions: [...g.conditions, newCondition(t)] })} disabled={disabled} />
      </div>
    </fieldset>
  );
}

function ConditionRow({
  c,
  onChange,
  onRemove,
  disabled,
}: {
  c: BuilderCondition;
  onChange: (c: BuilderCondition) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const error = validateCondition(c.condition);
  const set = (cond: SegmentCondition) => onChange({ ...c, condition: cond });
  return (
    <div
      className={cn(
        'rounded-xl border bg-surface p-3',
        error ? 'border-danger/50' : 'border-border',
        c.negate && 'border-l-4 border-l-warning',
      )}
      data-testid="segment-condition"
    >
      <div className="flex flex-wrap items-start gap-2">
        <Select
          selectSize="sm"
          aria-label="条件の種類"
          value={c.condition.type}
          onChange={(e) => set(defaultCondition(e.target.value as ConditionType))}
          disabled={disabled}
          className="w-auto! min-w-48"
        >
          {CONDITION_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </Select>
        <div className="min-w-0 flex-1">
          <ConditionParams cond={c.condition} onChange={set} disabled={disabled} />
        </div>
        <IconButton icon="x" label="条件を削除" size="sm" onClick={onRemove} disabled={disabled} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Checkbox
          label="この条件に一致する顧客を除外（NOT）"
          checked={c.negate}
          onChange={(e) => onChange({ ...c, negate: e.target.checked })}
          disabled={disabled}
          className="text-xs"
        />
        {CONDITION_TYPES.find((t) => t.type === c.condition.type)?.hint ? (
          <span className="text-[11px] text-subtle">{CONDITION_TYPES.find((t) => t.type === c.condition.type)?.hint}</span>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  label,
  suffix,
  min = 0,
  step = 1,
  disabled,
  optional,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  label: string;
  suffix?: string;
  min?: number;
  step?: number;
  disabled?: boolean;
  optional?: boolean;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-[13px]">
      <span className="sr-only">{label}</span>
      <Input
        type="number"
        inputSize="sm"
        aria-label={label}
        className="w-24!"
        min={min}
        step={step}
        value={value ?? ''}
        placeholder={optional ? '指定なし' : undefined}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        disabled={disabled}
      />
      {suffix ? <span className="text-muted">{suffix}</span> : null}
    </label>
  );
}

function ChipSelect({
  options,
  value,
  onChange,
  label,
  disabled,
  empty,
}: {
  options: { id: string; label: string; color?: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  label: string;
  disabled?: boolean;
  empty?: string;
}) {
  if (!options.length) return <p className="text-xs text-muted">{empty ?? '選択肢がありません'}</p>;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50',
              on ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-muted hover:text-fg',
            )}
          >
            {o.color ? <span className="h-2 w-2 rounded-full" style={{ background: o.color }} aria-hidden /> : null}
            {on ? <span aria-hidden>✓</span> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 text-[13px]">{children}</div>;
}

function ConditionParams({
  cond,
  onChange,
  disabled,
}: {
  cond: SegmentCondition;
  onChange: (c: SegmentCondition) => void;
  disabled?: boolean;
}) {
  const { shops, currentShopId } = useAuth();
  const needsMenus = cond.type === 'used_menu';
  const needsStaff = cond.type === 'primary_staff';
  const needsTags = cond.type === 'tag';
  const menus = useMenus(needsMenus ? currentShopId : null, true);
  const staff = useStaffList({}, needsStaff);
  const tags = useTags();

  switch (cond.type) {
    case 'last_visit_days_gt':
    case 'last_visit_days_lte':
      return (
        <Row>
          <NumberInput label="日数" value={cond.days} onChange={(n) => onChange({ ...cond, days: n ?? 0 })} suffix="日" disabled={disabled} />
        </Row>
      );
    case 'first_visit_within_days_without_return':
      return (
        <Row>
          <span className="text-muted">初回来店から</span>
          <NumberInput label="日数" value={cond.days} onChange={(n) => onChange({ ...cond, days: n ?? 0 })} suffix="日" disabled={disabled} />
          <Select
            selectSize="sm"
            aria-label="期間の扱い"
            className="w-auto!"
            value={cond.windowElapsed === false ? 'within' : 'elapsed'}
            onChange={(e) => onChange({ ...cond, windowElapsed: e.target.value !== 'within' })}
            disabled={disabled}
          >
            <option value="elapsed">以上経過して未再来</option>
            <option value="within">以内でまだ未再来（フォロー対象）</option>
          </Select>
        </Row>
      );
    case 'ltv_top_percent':
      return (
        <Row>
          <span className="text-muted">上位</span>
          <NumberInput label="割合" value={cond.percent} min={0.1} step={0.1} onChange={(n) => onChange({ ...cond, percent: n ?? 0 })} suffix="%" disabled={disabled} />
        </Row>
      );
    case 'used_menu':
      return (
        <div className="space-y-2">
          {menus.isLoading ? <InlineLoading /> : null}
          <ChipSelect
            label="メニュー"
            options={(menus.data ?? []).map((m) => ({ id: m.id, label: m.name }))}
            value={cond.menuIds}
            onChange={(ids) => onChange({ ...cond, menuIds: ids })}
            disabled={disabled}
          />
          <Row>
            <span className="text-muted">期間</span>
            <NumberInput label="期間（日）" optional value={cond.withinDays} onChange={(n) => onChange({ ...cond, withinDays: n })} suffix="日以内（空欄=全期間）" disabled={disabled} />
          </Row>
        </div>
      );
    case 'birthday_month':
      return (
        <Row>
          <Select
            selectSize="sm"
            aria-label="月"
            className="w-auto!"
            value={String(cond.month ?? 'current')}
            onChange={(e) => {
              const v = e.target.value;
              onChange({ ...cond, month: v === 'current' || v === 'next' ? v : Number(v) });
            }}
            disabled={disabled}
          >
            <option value="current">今月（配信時点）</option>
            <option value="next">来月（配信時点）</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}月
              </option>
            ))}
          </Select>
        </Row>
      );
    case 'primary_staff':
      return (
        <ChipSelect
          label="担当スタッフ"
          options={(staff.data ?? []).map((s) => ({ id: s.id, label: s.display_name, color: s.color }))}
          value={cond.staffIds}
          onChange={(ids) => onChange({ ...cond, staffIds: ids })}
          disabled={disabled}
        />
      );
    case 'shop':
      return (
        <ChipSelect
          label="店舗"
          options={shops.map((s) => ({ id: s.id, label: s.name }))}
          value={cond.shopIds}
          onChange={(ids) => onChange({ ...cond, shopIds: ids })}
          disabled={disabled}
        />
      );
    case 'tag':
      return (
        <div className="space-y-2">
          <ChipSelect
            label="タグ"
            options={(tags.data ?? []).map((t) => ({ id: t.id, label: t.name, color: t.color }))}
            value={cond.tagIds}
            onChange={(ids) => onChange({ ...cond, tagIds: ids })}
            disabled={disabled}
            empty={needsTags && tags.isLoading ? '読み込み中…' : 'タグがありません'}
          />
          <Select
            selectSize="sm"
            aria-label="タグの一致条件"
            className="w-auto!"
            value={cond.match ?? 'any'}
            onChange={(e) => onChange({ ...cond, match: e.target.value as 'any' | 'all' })}
            disabled={disabled}
          >
            <option value="any">いずれかのタグを持つ</option>
            <option value="all">すべてのタグを持つ</option>
          </Select>
        </div>
      );
    case 'visit_count':
      return (
        <Row>
          <NumberInput label="来店回数の下限" optional value={cond.gte} onChange={(n) => onChange({ ...cond, gte: n })} suffix="回以上" disabled={disabled} />
          <NumberInput label="来店回数の上限" optional value={cond.lte} onChange={(n) => onChange({ ...cond, lte: n })} suffix="回以下" disabled={disabled} />
        </Row>
      );
    case 'no_review':
      return (
        <Row>
          <span className="text-muted">直近</span>
          <NumberInput label="期間（日）" optional value={cond.withinDays} onChange={(n) => onChange({ ...cond, withinDays: n })} suffix="日（空欄=これまで一度も）" disabled={disabled} />
        </Row>
      );
    case 'marketing_opt_in':
      return (
        <Row>
          <Select
            selectSize="sm"
            aria-label="配信許可"
            className="w-auto!"
            value={cond.value === false ? 'no' : 'yes'}
            onChange={(e) => onChange({ ...cond, value: e.target.value === 'yes' })}
            disabled={disabled}
          >
            <option value="yes">販促メッセージを許可している</option>
            <option value="no">販促メッセージを拒否している</option>
          </Select>
        </Row>
      );
    case 'no_future_appointment':
    case 'has_future_appointment':
      return <p className="pt-1 text-xs text-muted">追加の設定はありません。</p>;
  }
}

/** Live preview: target count + sample customers for the current builder state */
export function SegmentPreview({ state, shopId, compact }: { state: BuilderState; shopId?: string; compact?: boolean }) {
  const { timezone: tz } = useAuth();
  const errors = validateState(state);
  const rule = useMemo(() => (errors.length ? null : toRule(state)), [state, errors.length]);
  const debounced = useDebounced(rule, 400);
  const q = useQuery({
    queryKey: ['messaging', 'segment-preview', debounced, shopId],
    queryFn: () => messagingApi.previewSegment({ rule: debounced!, shopId, sampleSize: 8 }),
    enabled: !!debounced,
    placeholderData: (prev) => prev,
  });
  return (
    <div className="space-y-3" aria-live="polite">
      <div className="rounded-2xl border border-border bg-surface-2/60 p-4">
        <p className="text-xs text-muted">対象人数（現在の条件）</p>
        <p className="mt-1 text-3xl font-semibold tracking-tight text-fg" data-testid="segment-count">
          {!rule ? '—' : q.data ? `${q.data.count.toLocaleString('ja-JP')}人` : '…'}
        </p>
        <p className="mt-1 text-xs text-subtle">
          削除済み・統合済み・受付停止の顧客は含みません。配信時は配信許可・チャネルの同意も確認されます。
        </p>
      </div>
      {errors.length ? (
        <Alert tone="warning" title="条件を確認してください">
          <ul className="list-disc pl-4">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {q.error ? <Alert tone="danger">{errorMessage(q.error)}</Alert> : null}
      {q.data?.sample.length ? (
        <Table caption="対象顧客のサンプル" className={cn(q.isFetching && 'opacity-60')}>
          <THead>
            <Tr>
              <Th>サンプル（最終来店順）</Th>
              <Th className="text-right">来店</Th>
              {!compact ? <Th className="hidden text-right sm:table-cell">累計売上</Th> : null}
            </Tr>
          </THead>
          <TBody>
            {q.data.sample.map((s) => (
              <Tr key={s.id}>
                <Td>
                  <p className="font-medium">{s.display_name || '（氏名未登録）'}</p>
                  <p className="text-xs text-subtle">
                    最終来店 {s.last_visit_at ? formatDate(s.last_visit_at, tz, { weekday: false }) : '—'}
                    {!s.marketing_opt_in ? ' ・配信拒否' : ''}
                  </p>
                </Td>
                <Td className="text-right tabular">{s.visit_count}回</Td>
                {!compact ? <Td className="hidden text-right tabular sm:table-cell">{formatYen(s.total_sales)}</Td> : null}
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
    </div>
  );
}
