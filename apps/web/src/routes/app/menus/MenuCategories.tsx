import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Plus, SquarePen, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { catalogApi, catalogKeys, useCategories } from '../../../api/catalog';
import type { MenuCategory } from '../../../api/types';
import { Button, Card, CardContent, Dialog, DialogTitle, Input, Label } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cx } from '../../../lib/cn';
import { CATEGORY_SEPARATOR, DEFAULT_CATEGORY_COLOR } from './model';

/** Colours a parent category can take (also the colour of its reservations on the calendar) */
const COLORS = [
  { name: 'グレー', value: '#6B7280' },
  { name: 'レッド', value: '#EF4444' },
  { name: 'オレンジ', value: '#F97316' },
  { name: 'イエロー', value: '#EAB308' },
  { name: 'グリーン', value: '#22C55E' },
  { name: 'ティール', value: '#14B8A6' },
  { name: 'ブルー', value: '#3B82F6' },
  { name: 'インディゴ', value: '#6366F1' },
  { name: 'パープル', value: '#A855F7' },
  { name: 'ピンク', value: '#EC4899' },
];

/** 「ネイル：ジェル」 under ネイル → 「ジェル」 (the name as stored when it does not start with its parent) */
function childName(c: MenuCategory, parents: MenuCategory[]): string {
  if (!c.parent_id) return c.name;
  const parent = parents.find((p) => p.id === c.parent_id);
  if (!parent) return c.name;
  for (const prefix of [`${parent.name} ${CATEGORY_SEPARATOR} `, `${parent.name}${CATEGORY_SEPARATOR}`]) {
    if (c.name.startsWith(prefix)) return c.name.slice(prefix.length);
  }
  return c.name;
}

const colorOf = (c: MenuCategory) => c.color ?? DEFAULT_CATEGORY_COLOR;

/** 親カテゴリ: select whose items show the category's colour dot (the shared Select takes text only) */
function ParentSelect({
  value,
  onValueChange,
  parents,
}: {
  value: string;
  onValueChange: (id: string) => void;
  parents: MenuCategory[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const item = (p: MenuCategory) => (
    <div className="flex items-center gap-2">
      <div className="h-3 w-3 rounded-full" style={{ backgroundColor: colorOf(p) }} />
      {p.name}
    </div>
  );
  const current = parents.find((p) => p.id === value);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label="親カテゴリ"
        data-state={open ? 'open' : 'closed'}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs ring-offset-background placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"
      >
        <span style={{ pointerEvents: 'none' }}>
          {current ? item(current) : <span className="text-muted-foreground">親カテゴリを選択</span>}
        </span>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 max-h-96 min-w-full overflow-y-auto overflow-x-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="p-1">
            {parents.map((p) => (
              <div
                key={p.id}
                role="option"
                aria-selected={p.id === value}
                onClick={() => {
                  setOpen(false);
                  onValueChange(p.id);
                }}
                className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-hidden hover:bg-accent hover:text-accent-foreground"
              >
                <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                  {p.id === value ? <Check className="h-4 w-4" /> : null}
                </span>
                <span>{item(p)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type Mode = 'parent' | 'child';

/** カテゴリ管理: 親カテゴリ（色つき）と、その配下の子カテゴリ（「親：子」） */
export default function MenuCategories() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { currentShopId: shopId, can } = useAuth();
  const canManage = can('menu.manage');
  const categoriesQ = useCategories(shopId ?? undefined);

  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('parent');
  const [editing, setEditing] = useState<MenuCategory | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_CATEGORY_COLOR);
  const [parentId, setParentId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const categories = useMemo(() => categoriesQ.data ?? [], [categoriesQ.data]);
  const parents = useMemo(() => categories.filter((c) => !c.parent_id), [categories]);
  const childrenOf = (id: string) => categories.filter((c) => c.parent_id === id);

  // every parent is open whenever the list is (re)loaded
  useEffect(() => {
    setExpanded(new Set((categoriesQ.data ?? []).filter((c) => !c.parent_id).map((c) => c.id)));
  }, [categoriesQ.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: catalogKeys.all });
  /** a new category goes after its siblings */
  const nextOrder = (siblings: MenuCategory[]) => siblings.reduce((max, c) => Math.max(max, c.sort_order), -1) + 1;

  const openAddParent = () => {
    setMode('parent');
    setEditing(null);
    setName('');
    setColor(COLORS[parents.length % COLORS.length]!.value);
    setParentId('');
    setDialogOpen(true);
  };
  const openAddChild = (parent: string) => {
    setMode('child');
    setEditing(null);
    setName('');
    setColor('');
    setParentId(parent);
    setDialogOpen(true);
  };
  const openEdit = (c: MenuCategory) => {
    if (c.parent_id) {
      setMode('child');
      setParentId(c.parent_id);
      setName(childName(c, parents));
      setColor('');
    } else {
      setMode('parent');
      setParentId('');
      setName(c.name);
      setColor(c.color ?? '');
    }
    setEditing(c);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || !shopId) return;
    setSaving(true);
    try {
      if (mode === 'parent') {
        // renaming a parent renames its children's 「親：子」 on the server
        if (editing) await catalogApi.updateCategory(editing.id, { name: trimmed, color: color || null });
        else {
          await catalogApi.createCategory({
            shopId,
            name: trimmed,
            color: color || null,
            parentId: null,
            sortOrder: nextOrder(parents),
          });
        }
      } else {
        const parent = parents.find((p) => p.id === parentId);
        if (!parent) return;
        // the server stores the child as 「親：子」 with its parent's colour
        if (editing) await catalogApi.updateCategory(editing.id, { name: trimmed, parentId: parent.id });
        else {
          await catalogApi.createCategory({
            shopId,
            name: trimmed,
            parentId: parent.id,
            sortOrder: nextOrder(childrenOf(parent.id)),
          });
        }
      }
      await refresh();
      setDialogOpen(false);
    } catch (e) {
      toast.error('保存に失敗しました', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: MenuCategory) => {
    const label = c.parent_id ? childName(c, parents) : c.name;
    const children = c.parent_id ? [] : childrenOf(c.id);
    const message =
      children.length > 0
        ? `「${label}」と配下の${children.length}件の子カテゴリを削除しますか？`
        : `「${label}」を削除しますか？`;
    if (!window.confirm(message)) return;
    try {
      await catalogApi.deleteCategory(c.id);
      await refresh();
    } catch (e) {
      toast.error('削除に失敗しました。メニューで使用されている可能性があります。', errorMessage(e));
    }
  };

  const handleDeleteAll = async () => {
    if (!shopId || !window.confirm('すべてのカテゴリを削除しますか？')) return;
    try {
      const result = await catalogApi.deleteAllCategories(shopId);
      await refresh();
      if (result.kept > 0) {
        toast.info(
          `全店共通のカテゴリ${result.kept}件は削除されませんでした`,
          '全店舗の権限を持つスタッフだけが削除できます',
        );
      }
    } catch (e) {
      toast.error('カテゴリの削除に失敗しました', errorMessage(e));
    }
  };

  if (!shopId || categoriesQ.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl sy-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate('/app/menus')}>
          <ChevronLeft className="mr-1 h-4 w-4" />
          メニュー一覧に戻る
        </Button>
        <div className="flex gap-2">
          {categories.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage}
              onClick={() => void handleDeleteAll()}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="mr-1 h-4 w-4" />
              全削除
            </Button>
          ) : null}
        </div>
      </div>

      <h1 className="text-xl font-bold">カテゴリ管理</h1>

      <Card>
        <CardContent className="p-4 sy-1">
          {parents.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              カテゴリがありません。ボタンから追加してください。
            </p>
          ) : (
            parents.map((p) => {
              const children = childrenOf(p.id);
              const open = expanded.has(p.id);
              return (
                <div key={p.id}>
                  <div
                    data-category={p.id}
                    className="group flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/50"
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${p.name} を${open ? '閉じる' : '開く'}`}
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        })
                      }
                      className="p-0.5"
                    >
                      {open ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                    <div className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: colorOf(p) }} />
                    <span className="flex-1 text-sm font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{children.length}件</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100"
                      aria-label={`${p.name} に子カテゴリを追加`}
                      disabled={!canManage}
                      onClick={() => openAddChild(p.id)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100"
                      aria-label={`${p.name} を編集`}
                      disabled={!canManage}
                      onClick={() => openEdit(p)}
                    >
                      <SquarePen className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive opacity-0 group-hover:opacity-100"
                      aria-label={`${p.name} を削除`}
                      disabled={!canManage}
                      onClick={() => void handleDelete(p)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {open && children.length > 0 ? (
                    <div className="ml-7 border-l-2 pl-3" style={{ borderColor: `${colorOf(p)}40` }}>
                      {children.map((c) => {
                        const label = childName(c, parents);
                        return (
                          <div
                            key={c.id}
                            data-category={c.id}
                            className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                          >
                            <span className="flex-1 text-sm">{label}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                              aria-label={`${c.name} を編集`}
                              disabled={!canManage}
                              onClick={() => openEdit(c)}
                            >
                              <SquarePen className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-destructive opacity-0 group-hover:opacity-100"
                              aria-label={`${c.name} を削除`}
                              disabled={!canManage}
                              onClick={() => void handleDelete(c)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Button variant="outline" onClick={openAddParent} disabled={!canManage} className="w-full">
        <Plus className="mr-1 h-4 w-4" />
        親カテゴリを追加
      </Button>

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        className="max-w-sm"
        title={
          <DialogTitle>
            {editing
              ? mode === 'parent'
                ? '親カテゴリ編集'
                : '子カテゴリ編集'
              : mode === 'parent'
                ? '親カテゴリ追加'
                : '子カテゴリ追加'}
          </DialogTitle>
        }
      >
        <div className="sy-4">
          {mode === 'child' ? (
            <div className="sy-2">
              <Label>親カテゴリ</Label>
              <ParentSelect value={parentId} onValueChange={setParentId} parents={parents} />
            </div>
          ) : null}
          <div className="sy-2">
            <Label htmlFor="category-name">{mode === 'parent' ? 'カテゴリ名' : '子カテゴリ名'}</Label>
            <Input
              id="category-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={mode === 'parent' ? 'ネイル' : 'ジェル'}
              onKeyDown={(e) => {
                // Enter that confirms a kana conversion must not save
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSave();
              }}
            />
          </div>
          {mode === 'parent' ? (
            <div className="sy-2">
              <Label>色</Label>
              <div className="flex flex-wrap gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    aria-label={c.name}
                    aria-pressed={color.toUpperCase() === c.value}
                    className={cx(
                      'h-8 w-8 rounded-full border-2 transition-all',
                      color.toUpperCase() === c.value
                        ? 'scale-110 border-foreground'
                        : 'border-transparent hover:scale-105',
                    )}
                    style={{ backgroundColor: c.value }}
                    onClick={() => setColor(c.value)}
                    title={c.name}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:sx-2">
          <Button variant="outline" onClick={() => setDialogOpen(false)}>
            キャンセル
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || !name.trim()}>
            {saving ? '保存中...' : editing ? '更新' : '追加'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
