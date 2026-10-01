import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  FORM_KIND_LABEL,
  FORM_STATUS_LABEL,
  formKeys,
  formsApi,
  useFormTemplates,
  type FormKind,
  type FormStatus,
  type FormTemplate,
} from '../../../api/forms';
import {
  ATTRIBUTE_KEYS,
  ATTRIBUTE_LABEL,
  FIELD_TYPE_LABEL,
  type AttributeKey,
  type FieldDef,
  type FieldType,
} from '../../../api/kartes';
import { DynamicField } from '../../../components/forms/DynamicField';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  InlineLoading,
  Input,
  PageHeader,
  Select,
  Switch,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage, isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { formatDateTime } from '../../../lib/format';

const KINDS: FormKind[] = ['counseling', 'consent', 'pre_visit'];
const FORM_FIELD_TYPES: FieldType[] = [
  'text',
  'textarea',
  'number',
  'select',
  'multiselect',
  'checkbox',
  'date',
];

export default function FormTemplates() {
  const { can, timezone: tz } = useAuth();
  const [archived, setArchived] = useState(false);
  const q = useFormTemplates({ includeArchived: archived });
  const [editing, setEditing] = useState<FormTemplate | 'new' | null>(null);
  const [versions, setVersions] = useState<FormTemplate | null>(null);
  const [archiving, setArchiving] = useState<FormTemplate | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('form.manage');

  const archive = async (t: FormTemplate) => {
    try {
      await formsApi.archiveTemplate(t.id);
      toast.success('アーカイブしました');
      void qc.invalidateQueries({ queryKey: formKeys.all });
    } catch (e) {
      toast.error(e);
    } finally {
      setArchiving(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        back={
          <Link
            to="/app/kartes"
            className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"
          >
            <Icon name="chevron-left" size={16} /> カルテ
          </Link>
        }
        title="問診・同意書フォーム"
        description="回答済みの版を編集すると新しい版が作成され、過去の回答は提出時の版のまま保存されます。"
        actions={
          manage ? (
            <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing('new')}>
              フォームを作成
            </Button>
          ) : null
        }
      />
      <div className="mb-4">
        <Switch
          checked={archived}
          onChange={setArchived}
          label="アーカイブ済み・旧版も表示"
          className="max-w-xs"
        />
      </div>
      {q.isLoading ? <InlineLoading /> : null}
      {q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : null}
      {q.data && !q.data.length ? <EmptyState icon="file" title="フォームがありません" /> : null}
      <div className="space-y-6">
        {KINDS.map((kind) => {
          const list = (q.data ?? []).filter((t) => t.kind === kind);
          if (!list.length) return null;
          return (
            <section key={kind}>
              <h2 className="mb-2 text-sm font-semibold text-muted">{FORM_KIND_LABEL[kind]}</h2>
              <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
                {list.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {t.name} <span className="text-xs text-muted">v{t.version}</span>
                      </p>
                      <p className="text-xs text-muted">
                        項目 {t.fields.length} ・ {t.requires_signature ? '署名あり' : '署名なし'}{' '}
                        ・ {t.shop_id ? '店舗独自' : '法人共通'} ・ 更新{' '}
                        {formatDateTime(t.updated_at, tz)}
                      </p>
                    </div>
                    <Badge
                      size="sm"
                      tone={
                        t.status === 'active'
                          ? 'success'
                          : t.status === 'draft'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {FORM_STATUS_LABEL[t.status]}
                    </Badge>
                    <Button size="xs" variant="ghost" onClick={() => setVersions(t)}>
                      版の履歴
                    </Button>
                    {manage && t.status !== 'archived' ? (
                      <>
                        <Button size="xs" icon="edit" onClick={() => setEditing(t)}>
                          編集
                        </Button>
                        <IconButton
                          icon="trash"
                          size="xs"
                          label={`${t.name}をアーカイブ`}
                          onClick={() => setArchiving(t)}
                        />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {editing ? (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {versions ? <VersionsDialog template={versions} onClose={() => setVersions(null)} /> : null}
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        title="フォームをアーカイブしますか？"
        description="新しい回答・リンク発行に使えなくなります。提出済みの回答はそのまま保存されます。"
        tone="danger"
        confirmLabel="アーカイブする"
        onConfirm={() => archiving && void archive(archiving)}
      />
    </div>
  );
}

function VersionsDialog({ template, onClose }: { template: FormTemplate; onClose: () => void }) {
  const { timezone: tz } = useAuth();
  const q = useQuery({
    queryKey: formKeys.versions(template.id),
    queryFn: () => formsApi.versions(template.id),
  });
  return (
    <Dialog open onClose={onClose} title={`${template.name} の版の履歴`}>
      {q.isLoading ? <InlineLoading /> : null}
      <ul className="divide-y divide-border">
        {(q.data ?? []).map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
            <span>
              v{v.version} ・ 項目 {v.fields.length}
              <span className="block text-xs text-muted">{formatDateTime(v.created_at, tz)}</span>
            </span>
            <Badge size="sm" tone={v.status === 'active' ? 'success' : 'neutral'}>
              {FORM_STATUS_LABEL[v.status]}
            </Badge>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function emptyField(i: number): FieldDef {
  return { key: `q${i + 1}`, label: '', type: 'text' };
}

function TemplateDialog({
  template,
  onClose,
}: {
  template: FormTemplate | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId, me } = useAuth();
  const [kind, setKind] = useState<FormKind>(template?.kind ?? 'counseling');
  const [name, setName] = useState(template?.name ?? '');
  const [scope, setScope] = useState<'common' | 'shop'>(
    template?.shop_id ? 'shop' : me?.allShops ? 'common' : 'shop',
  );
  const [fields, setFields] = useState<FieldDef[]>(template?.fields ?? [emptyField(0)]);
  const [body, setBody] = useState(template?.body_markdown ?? '');
  const [sig, setSig] = useState(template?.requires_signature ?? kind === 'consent');
  const [status, setStatus] = useState<FormStatus>(template?.status ?? 'active');
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upd = (i: number, patch: Partial<FieldDef>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) =>
    setFields((fs) => {
      const next = [...fs];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x!);
      return next;
    });

  const save = async () => {
    if (!name.trim()) return setError('フォーム名を入力してください');
    for (const [i, f] of fields.entries()) {
      if (!f.label.trim()) return setError(`${i + 1}番目の項目名を入力してください`);
      if (!/^[a-z][a-z0-9_]{0,49}$/.test(f.key))
        return setError(`${i + 1}番目のキーは英小文字で始まる英数字・_ で入力してください`);
      if ((f.type === 'select' || f.type === 'multiselect') && !f.options?.length)
        return setError(`「${f.label}」の選択肢を入力してください`);
    }
    if (new Set(fields.map((f) => f.key)).size !== fields.length)
      return setError('キーが重複しています');
    const cleaned = fields.map((f) => {
      const out: FieldDef = { key: f.key, label: f.label.trim(), type: f.type };
      if (f.type === 'select' || f.type === 'multiselect') out.options = f.options;
      if (f.required) out.required = true;
      if (f.helpText?.trim()) out.helpText = f.helpText.trim();
      if (f.mapsTo) out.mapsTo = f.mapsTo;
      return out;
    });
    setBusy(true);
    setError(null);
    try {
      if (template) {
        const r = await formsApi.updateTemplate(template.id, {
          name: name.trim(),
          fields: cleaned,
          bodyMarkdown: body.trim() || null,
          requiresSignature: sig,
          status,
        });
        toast.success(
          r.new_version ? `新しい版（v${r.version}）を作成しました` : 'フォームを更新しました',
        );
      } else {
        await formsApi.createTemplate({
          kind,
          name: name.trim(),
          shopId: scope === 'shop' ? currentShopId : null,
          fields: cleaned,
          bodyMarkdown: body.trim() || null,
          requiresSignature: sig,
          status: status === 'archived' ? 'active' : status,
        });
        toast.success('フォームを作成しました');
      }
      void qc.invalidateQueries({ queryKey: formKeys.all });
      onClose();
    } catch (e) {
      setError(
        isApiError(e) && e.code === 'TEMPLATE_SUPERSEDED'
          ? '新しい版が存在します。一覧を更新して最新版を編集してください。'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={template ? `${template.name}（v${template.version}）を編集` : 'フォームを作成'}
      dismissable={!busy}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setPreview((p) => !p)}>
            {preview ? '編集に戻る' : 'プレビュー'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      {error ? (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      ) : null}
      {preview ? (
        <div className="mx-auto max-w-md space-y-4">
          <h3 className="text-base font-semibold">{name || '（無題）'}</h3>
          {body ? (
            <p className="whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-[13px]">{body}</p>
          ) : null}
          {fields.map((f) => (
            <DynamicField key={f.key} field={f} value={undefined} onChange={() => undefined} />
          ))}
          {sig ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted">
              署名欄
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="種類">
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as FormKind)}
                disabled={!!template}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {FORM_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="フォーム名" required className="sm:col-span-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </Field>
            <Field label="対象">
              <Select
                value={scope}
                onChange={(e) => setScope(e.target.value as 'common' | 'shop')}
                disabled={!!template}
              >
                <option value="common">法人共通</option>
                <option value="shop">この店舗のみ</option>
              </Select>
            </Field>
            <Field label="状態">
              <Select value={status} onChange={(e) => setStatus(e.target.value as FormStatus)}>
                <option value="active">公開中</option>
                <option value="draft">下書き</option>
              </Select>
            </Field>
            <div className="flex items-end pb-2">
              <Checkbox
                label="署名を必須にする"
                checked={sig}
                onChange={(e) => setSig(e.target.checked)}
              />
            </div>
          </div>
          <Field
            label="説明・同意事項"
            hint="お客様に表示される本文（改行はそのまま表示されます）"
            optional
          >
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={50000}
            />
          </Field>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">質問項目</h3>
              <Button
                size="sm"
                icon="plus"
                onClick={() => setFields((fs) => [...fs, emptyField(fs.length)])}
                disabled={fields.length >= 100}
              >
                項目を追加
              </Button>
            </div>
            <ol className="space-y-3">
              {fields.map((f, i) => (
                <li key={i} className="rounded-xl border border-border p-3">
                  <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                    <Field label={`項目名 ${i + 1}`}>
                      <Input
                        value={f.label}
                        onChange={(e) => upd(i, { label: e.target.value })}
                        inputSize="sm"
                        maxLength={100}
                      />
                    </Field>
                    <Field label="形式">
                      <Select
                        value={f.type}
                        onChange={(e) => upd(i, { type: e.target.value as FieldType })}
                        selectSize="sm"
                      >
                        {FORM_FIELD_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {FIELD_TYPE_LABEL[t]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="キー" hint="英小文字・数字・_">
                      <Input
                        value={f.key}
                        onChange={(e) => upd(i, { key: e.target.value })}
                        inputSize="sm"
                        className="font-mono"
                      />
                    </Field>
                    <div className="flex items-end gap-0.5">
                      <IconButton
                        icon="chevron-up"
                        size="sm"
                        label="上へ"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      />
                      <IconButton
                        icon="chevron-down"
                        size="sm"
                        label="下へ"
                        disabled={i === fields.length - 1}
                        onClick={() => move(i, 1)}
                      />
                      <IconButton
                        icon="trash"
                        size="sm"
                        label={`項目${i + 1}を削除`}
                        onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
                      />
                    </div>
                  </div>
                  {f.type === 'select' || f.type === 'multiselect' ? (
                    <Field label="選択肢（改行区切り）" className="mt-2">
                      <Textarea
                        rows={3}
                        value={(f.options ?? []).join('\n')}
                        onChange={(e) =>
                          upd(i, {
                            options: e.target.value
                              .split('\n')
                              .map((x) => x.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </Field>
                  ) : null}
                  <div className="mt-2 grid gap-2 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
                    <Field label="補足説明" optional>
                      <Input
                        value={f.helpText ?? ''}
                        onChange={(e) => upd(i, { helpText: e.target.value })}
                        inputSize="sm"
                        maxLength={500}
                      />
                    </Field>
                    <Field label="顧客情報に反映" optional>
                      <Select
                        value={f.mapsTo ?? ''}
                        onChange={(e) =>
                          upd(i, {
                            mapsTo: (e.target.value || undefined) as AttributeKey | undefined,
                          })
                        }
                        selectSize="sm"
                      >
                        <option value="">反映しない</option>
                        {ATTRIBUTE_KEYS.map((k) => (
                          <option key={k} value={k}>
                            {ATTRIBUTE_LABEL[k]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Checkbox
                      className="pb-2"
                      label="必須"
                      checked={!!f.required}
                      onChange={(e) => upd(i, { required: e.target.checked })}
                    />
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Dialog>
  );
}
