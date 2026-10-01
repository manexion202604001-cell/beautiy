import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { orgApi, orgKeys, usePermissionCatalog, useRoles } from '../../../api/org';
import type { PermissionDef, Role } from '../../../api/types';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  Icon,
  InlineLoading,
  Input,
  PageHeader,
  Textarea,
  useToast,
} from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { PERMISSION_GROUPS } from './shared';

function groupPermissions(catalog: PermissionDef[]) {
  const groups = new Map<string, PermissionDef[]>();
  for (const p of catalog) {
    const g = PERMISSION_GROUPS[p.key.split('.')[0]!] ?? 'その他';
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  return [...groups.entries()];
}

export default function Roles() {
  const { can } = useAuth();
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can('role.manage');
  const groups = useMemo(() => groupPermissions(catalog.data ?? []), [catalog.data]);

  if (roles.isLoading || catalog.isLoading) return <InlineLoading />;
  if (roles.error) return <ErrorState error={roles.error} />;
  const list = roles.data ?? [];

  return (
    <div>
      <PageHeader
        title="権限ロール"
        description="ロールごとに操作できる機能の一覧です。システムロールの権限も調整でき、独自のカスタムロールを作成できます（オーナーは常に全権限）。"
        back={
          <Link to="/app/staff" className="text-[13px] text-muted hover:text-fg">
            ← スタッフ一覧
          </Link>
        }
        actions={
          manage ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              カスタムロールを作成
            </Button>
          ) : null
        }
      />
      {!manage ? (
        <Alert tone="info" className="mb-4">
          閲覧のみ可能です。ロールの変更には「権限ロールの変更」権限が必要です。
        </Alert>
      ) : null}
      <div
        className="scrollbar-thin overflow-auto rounded-2xl border border-border bg-surface"
        style={{ maxHeight: 'calc(100vh - 220px)' }}
      >
        <table className="w-full border-collapse text-[13px]">
          <caption className="sr-only">権限マトリクス</caption>
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-border">
              <th
                scope="col"
                className="sticky left-0 z-20 min-w-[14rem] bg-surface px-4 py-3 text-left text-xs font-medium text-muted"
              >
                権限
              </th>
              {list.map((r) => (
                <th
                  key={r.id}
                  scope="col"
                  className="min-w-[7.5rem] px-2 py-3 text-center align-bottom"
                >
                  <div className="text-[13px] font-semibold text-fg">{r.name}</div>
                  <div className="mt-0.5">
                    {r.is_system ? (
                      <Badge size="sm">システム</Badge>
                    ) : (
                      <Badge size="sm" tone="info">
                        カスタム
                      </Badge>
                    )}
                  </div>
                  {manage && r.key !== 'owner' ? (
                    <div className="mt-1 flex justify-center gap-1">
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() => setEditing(r)}
                      >
                        編集
                      </button>
                      {!r.is_system ? (
                        <button
                          type="button"
                          className="text-xs text-danger hover:underline"
                          onClick={() => setDeleting(r)}
                        >
                          削除
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, perms]) => (
              <GroupRows key={group} group={group} perms={perms} roles={list} />
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <RoleDialog
          role={editing === 'new' ? null : editing}
          catalog={catalog.data ?? []}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`ロール「${deleting?.name ?? ''}」を削除しますか？`}
        description="使用中のロールは削除できません。"
        tone="danger"
        confirmLabel="削除する"
        loading={busy}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await orgApi.deleteRole(deleting.id);
            void qc.invalidateQueries({ queryKey: orgKeys.roles });
            toast.success('ロールを削除しました');
            setDeleting(null);
          } catch (e) {
            toast.error(e);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function GroupRows({
  group,
  perms,
  roles,
}: {
  group: string;
  perms: PermissionDef[];
  roles: Role[];
}) {
  return (
    <>
      <tr className="border-b border-border bg-surface-2/70">
        <th
          scope="rowgroup"
          colSpan={roles.length + 1}
          className="sticky left-0 px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted"
        >
          {group}
        </th>
      </tr>
      {perms.map((p) => (
        <tr key={p.key} className="border-b border-border last:border-b-0 hover:bg-surface-2/40">
          <th scope="row" className="sticky left-0 bg-surface px-4 py-2 text-left font-normal">
            <span className="block text-fg">{p.label}</span>
            <span className="font-mono text-[11px] text-subtle">{p.key}</span>
          </th>
          {roles.map((r) => {
            const has = r.permissions.includes(p.key);
            return (
              <td key={r.id} className="px-2 py-2 text-center">
                {has ? (
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-primary">
                    <Icon name="check" size={14} title={`${r.name}: ${p.label} あり`} />
                  </span>
                ) : (
                  <span className="text-subtle" aria-label={`${r.name}: ${p.label} なし`}>
                    ・
                  </span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function RoleDialog({
  role,
  catalog,
  onClose,
}: {
  role: Role | null;
  catalog: PermissionDef[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const groups = useMemo(() => groupPermissions(catalog), [catalog]);

  const save = async () => {
    if (!name.trim()) return setError('ロール名を入力してください');
    if (!role && !/^[a-z][a-z0-9_]{1,40}$/.test(key))
      return setError('キーは英小文字で始まる英小文字・数字・_（2〜41文字）で入力してください');
    setSaving(true);
    setError(null);
    try {
      if (role)
        await orgApi.updateRole(role.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          permissions: perms,
        });
      else
        await orgApi.createRole({
          key,
          name: name.trim(),
          description: description.trim() || undefined,
          permissions: perms,
        });
      void qc.invalidateQueries({ queryKey: orgKeys.roles });
      toast.success(
        role ? 'ロールを更新しました' : 'ロールを作成しました',
        '権限の変更は監査ログに記録されます',
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
      size="xl"
      title={role ? `ロールを編集: ${role.name}` : 'カスタムロールを作成'}
      dismissable={!saving}
      footer={
        <>
          <span className="mr-auto text-[13px] text-muted">{perms.length}個の権限を選択中</span>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
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
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="ロール名" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
        </Field>
        <Field label="キー" hint="作成後は変更できません">
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={!!role}
            placeholder="senior_stylist"
          />
        </Field>
        <Field label="説明" optional>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={1}
            maxLength={200}
          />
        </Field>
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map(([group, list]) => {
          const all = list.every((p) => perms.includes(p.key));
          return (
            <fieldset key={group} className="rounded-xl border border-border p-3">
              <legend className="px-1 text-[13px] font-semibold">{group}</legend>
              <button
                type="button"
                className="mb-2 text-xs text-primary hover:underline"
                onClick={() =>
                  setPerms((x) =>
                    all
                      ? x.filter((k) => !list.some((p) => p.key === k))
                      : [...new Set([...x, ...list.map((p) => p.key)])],
                  )
                }
              >
                {all ? 'すべて外す' : 'すべて選択'}
              </button>
              <div className="space-y-2">
                {list.map((p) => (
                  <Checkbox
                    key={p.key}
                    label={p.label}
                    description={p.key}
                    checked={perms.includes(p.key)}
                    onChange={(e) =>
                      setPerms((x) =>
                        e.target.checked ? [...x, p.key] : x.filter((k) => k !== p.key),
                      )
                    }
                  />
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </Dialog>
  );
}
