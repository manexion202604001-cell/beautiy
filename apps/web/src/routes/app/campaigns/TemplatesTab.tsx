import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  CHANNEL_LABEL,
  TEMPLATE_CATEGORY_LABEL,
  messagingApi,
  useTemplates,
  type Channel,
  type MessageTemplate,
  type TemplateCategory,
} from '../../../api/messaging';
import {
  Alert,
  Badge,
  Button,
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
  TBody,
  THead,
  Table,
  Td,
  Textarea,
  Th,
  Tr,
  useToast,
} from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { useDebounced } from '../../../lib/hooks';

export const TEMPLATE_VARIABLES: { key: string; label: string }[] = [
  { key: 'customer.name', label: 'お客様名' },
  { key: 'customer.lastName', label: '姓' },
  { key: 'customer.firstName', label: '名' },
  { key: 'shop.name', label: '店舗名' },
  { key: 'shop.phone', label: '店舗電話' },
  { key: 'shop.bookingUrl', label: '予約URL' },
  { key: 'appointment.start', label: '予約日時' },
  { key: 'appointment.date', label: '予約日' },
  { key: 'appointment.time', label: '予約時刻' },
  { key: 'appointment.menus', label: 'メニュー' },
  { key: 'appointment.staff', label: '担当' },
  { key: 'appointment.reference', label: '予約番号' },
  { key: 'appointment.manageUrl', label: '予約確認URL' },
  { key: 'review.url', label: '口コミURL' },
  { key: 'unsubscribeUrl', label: '配信停止URL' },
];

/** S-51 テンプレート管理: system + custom templates, variable chips, live preview */
export function TemplatesTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [channel, setChannel] = useState<'' | Channel>('line');
  const [category, setCategory] = useState<'' | TemplateCategory>('');
  const templates = useTemplates({ channel: channel || undefined });
  const [editing, setEditing] = useState<MessageTemplate | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MessageTemplate | null>(null);
  const writable = can('template.manage');
  const list = (templates.data ?? []).filter((t) => !category || t.category === category);

  const del = useMutation({
    mutationFn: (id: string) => messagingApi.deleteTemplate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messaging', 'templates'] });
      toast.success('テンプレートを削除しました');
      setDeleting(null);
    },
    onError: (e) => toast.error(e),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <Field label="チャネル">
            <Select selectSize="sm" value={channel} onChange={(e) => setChannel(e.target.value as '' | Channel)}>
              <option value="">すべて</option>
              {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="カテゴリ">
            <Select selectSize="sm" value={category} onChange={(e) => setCategory(e.target.value as '' | TemplateCategory)}>
              <option value="">すべて</option>
              {(Object.keys(TEMPLATE_CATEGORY_LABEL) as TemplateCategory[]).map((c) => (
                <option key={c} value={c}>
                  {TEMPLATE_CATEGORY_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {writable ? (
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            テンプレートを作成
          </Button>
        ) : null}
      </div>
      {templates.isLoading ? <InlineLoading /> : null}
      {templates.error ? <ErrorState error={templates.error} onRetry={() => void templates.refetch()} /> : null}
      {templates.data && !list.length ? <EmptyState icon="file" title="テンプレートがありません" /> : null}
      {list.length ? (
        <Table caption="メッセージテンプレート">
          <THead>
            <Tr>
              <Th>名前</Th>
              <Th>チャネル</Th>
              <Th className="hidden md:table-cell">カテゴリ</Th>
              <Th className="hidden lg:table-cell">本文</Th>
              <Th>状態</Th>
              <Th className="w-24">
                <span className="sr-only">操作</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {list.map((t) => (
              <Tr key={t.id}>
                <Td>
                  <p className="font-medium">{t.name}</p>
                  <p className="text-xs text-subtle">
                    {t.isSystem ? <Badge size="sm" tone="info">システム</Badge> : null} {t.shop_id ? '店舗独自' : '法人共通'}
                  </p>
                </Td>
                <Td>{CHANNEL_LABEL[t.channel]}</Td>
                <Td className="hidden md:table-cell">{TEMPLATE_CATEGORY_LABEL[t.category] ?? t.category}</Td>
                <Td className="hidden max-w-md lg:table-cell">
                  <p className="line-clamp-2 text-xs text-muted">{t.body}</p>
                </Td>
                <Td>
                  <Badge tone={t.status === 'active' ? 'success' : 'neutral'}>{t.status === 'active' ? '有効' : '無効'}</Badge>
                </Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    <IconButton icon={writable ? 'edit' : 'search'} label={writable ? '編集' : '表示'} size="sm" onClick={() => setEditing(t)} />
                    {writable && !(t.isSystem && !t.shop_id) ? (
                      <IconButton icon="trash" label="削除" size="sm" onClick={() => setDeleting(t)} />
                    ) : null}
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      {editing ? (
        <TemplateDialog template={editing === 'new' ? null : editing} readOnly={!writable} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="テンプレートを削除しますか？"
        description="送信済みメッセージの本文は残ります。配信予定のキャンペーン・有効な自動配信で使用中の場合は削除できません。"
        tone="danger"
        confirmLabel="削除する"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </div>
  );
}

function TemplateDialog({
  template,
  readOnly,
  onClose,
}: {
  template: MessageTemplate | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId, me } = useAuth();
  const [name, setName] = useState(template?.name ?? '');
  const [channel, setChannel] = useState<Channel>(template?.channel ?? 'line');
  const [category, setCategory] = useState<TemplateCategory>(template?.category ?? 'marketing');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [body, setBody] = useState(template?.body ?? '{{customer.name}}様\n\nいつもありがとうございます。{{shop.name}}です。\n\nご予約はこちら: {{shop.bookingUrl}}');
  const [active, setActive] = useState((template?.status ?? 'active') === 'active');
  const [scope, setScope] = useState<'org' | 'shop'>(template ? (template.shop_id ? 'shop' : 'org') : me?.allShops ? 'org' : 'shop');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dBody = useDebounced(body, 300);
  const dSubject = useDebounced(subject, 300);

  const preview = useQuery({
    queryKey: ['messaging', 'template-preview', dBody, dSubject, channel],
    queryFn: () =>
      messagingApi.previewTemplate({ body: dBody, subject: channel === 'email' ? dSubject || null : null, shopId: currentShopId ?? undefined }),
    enabled: !!dBody.trim(),
    placeholderData: (p) => p,
  });

  const insertVar = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: name.trim(),
        category,
        subject: channel === 'email' ? subject.trim() || null : null,
        body,
        status: active ? ('active' as const) : ('inactive' as const),
      };
      return template
        ? messagingApi.updateTemplate(template.id, common)
        : messagingApi.createTemplate({ ...common, channel, shopId: scope === 'shop' ? currentShopId : null });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messaging', 'templates'] });
      toast.success(template ? 'テンプレートを更新しました' : 'テンプレートを作成しました');
      onClose();
    },
    onError: (e) => toast.error(e),
  });

  const valid = name.trim() && body.trim() && (channel !== 'email' || subject.trim());

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={readOnly ? 'テンプレート' : template ? 'テンプレートを編集' : 'テンプレートを作成'}
      dismissable={!save.isPending}
      footer={
        readOnly ? (
          <Button onClick={onClose}>閉じる</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
              保存
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {template?.isSystem ? (
            <Alert tone="info">システムテンプレート（{template.key}）です。予約通知などで自動的に使われます。削除はできませんが、無効化・文面の変更ができます。</Alert>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="名前" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} disabled={readOnly} />
            </Field>
            <Field label="カテゴリ">
              <Select value={category} onChange={(e) => setCategory(e.target.value as TemplateCategory)} disabled={readOnly}>
                {(Object.keys(TEMPLATE_CATEGORY_LABEL) as TemplateCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {TEMPLATE_CATEGORY_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="チャネル" hint={template ? '作成後は変更できません' : undefined}>
              <Select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} disabled={readOnly || !!template}>
                {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="対象" hint={template ? '作成後は変更できません' : '法人共通の作成には全店舗権限が必要です'}>
              <Select value={scope} onChange={(e) => setScope(e.target.value as 'org' | 'shop')} disabled={readOnly || !!template}>
                <option value="org">法人共通</option>
                <option value="shop">この店舗のみ</option>
              </Select>
            </Field>
          </div>
          {channel === 'email' ? (
            <Field label="件名" required>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={readOnly} />
            </Field>
          ) : null}
          <Field label="本文" required hint="{{#変数}}…{{/変数}} で値があるときだけ表示する部分を作れます">
            <Textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={10} maxLength={5000} disabled={readOnly} />
          </Field>
          {!readOnly ? (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">変数を挿入（クリックでカーソル位置に追加）</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="変数">
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => insertVar(v.key)}
                    className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-fg hover:border-primary hover:text-primary"
                    title={`{{${v.key}}}`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <Switch checked={active} onChange={setActive} label="有効" disabled={readOnly} description="無効にすると送信・配信に使われません。" />
        </div>
        <div className="space-y-2">
          <p className="text-[13px] font-semibold">プレビュー（サンプルの値）</p>
          <div className="rounded-2xl border border-border bg-[#e9f5ee] p-3 dark:bg-surface-2">
            <div className="max-w-full rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 text-sm text-[#1c1917] shadow-sm dark:bg-surface dark:text-fg">
              {preview.data?.subject ? <p className="mb-1 font-semibold">{preview.data.subject}</p> : null}
              <p className="whitespace-pre-wrap break-words" data-testid="template-preview">
                {preview.data?.body ?? (preview.isFetching ? '…' : '本文を入力してください')}
              </p>
            </div>
          </div>
          {preview.data?.unknownVariables.length ? (
            <Alert tone="warning" title="不明な変数">
              {preview.data.unknownVariables.map((v) => `{{${v}}}`).join(' ')}
            </Alert>
          ) : null}
          {preview.data?.variables.length ? (
            <p className="text-xs text-muted">使用中の変数: {preview.data.variables.join(', ')}</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
