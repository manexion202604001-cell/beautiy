import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Grid3x3,
  ImagePlus,
  List,
  Palette,
  Plus,
  SquarePen,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { catalogApi, catalogKeys, useCategories, useMenus } from '../../../api/catalog';
import { sameOriginBlobUrl } from '../../../api/files';
import { useStaffList } from '../../../api/org';
import { useEquipment } from '../../../api/storeSettings';
import type { EffectiveMenu } from '../../../api/types';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, buttonVariants } from '../../../components/shad';
import { useToast } from '../../../components/ui';
import { errorMessage, isApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { cx } from '../../../lib/cn';
import { formatCurrency, formatDuration } from '../reservations/model';
import {
  colorByCategoryName,
  couponTypeClass,
  couponTypeLabel,
  groupColor,
  groupMenus,
  isCoupon,
  isListed,
} from './model';

type View = 'list' | 'staff-matrix' | 'equipment-matrix';
type MenuTab = 'regular' | 'coupon';
type CouponFilter = 'all' | 'everyone' | 'new' | 'repeat';

const COUPON_FILTERS: { key: CouponFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'everyone', label: '全員' },
  { key: 'new', label: '新規' },
  { key: 'repeat', label: '再来' },
];

const matchesFilter = (m: EffectiveMenu, f: CouponFilter) =>
  f === 'all' ? true : f === 'everyone' ? (m.couponType ?? 'all') === 'all' : m.couponType === f;

const ARROW =
  'p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground';

function MenuRow({
  menu,
  isFirst,
  isLast,
  expired,
  disabled,
  onMoveUp,
  onMoveDown,
  onToggleActive,
  onDelete,
  onNavigate,
}: {
  menu: EffectiveMenu;
  isFirst: boolean;
  isLast: boolean;
  /** past its 有効期限: still listed here, no longer offered for reservations */
  expired: boolean;
  /** no permission to change menus: the controls stay visible but inert */
  disabled: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleActive: (m: EffectiveMenu) => void;
  onDelete: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  const listed = isListed(menu);
  const image = menu.imageUrl ? sameOriginBlobUrl(menu.imageUrl) : null;
  const arrows = (
    <div className="flex shrink-0 flex-col">
      <button
        type="button"
        aria-label="上へ移動"
        className={ARROW}
        disabled={isFirst || disabled}
        onClick={(e) => {
          e.stopPropagation();
          onMoveUp();
        }}
      >
        <ChevronUp className="h-5 w-5" />
      </button>
      <button
        type="button"
        aria-label="下へ移動"
        className={ARROW}
        disabled={isLast || disabled}
        onClick={(e) => {
          e.stopPropagation();
          onMoveDown();
        }}
      >
        <ChevronDown className="h-5 w-5" />
      </button>
    </div>
  );
  const couponBadge = (padding: string) =>
    menu.couponType ? (
      <span
        className={cx(
          'inline-flex shrink-0 items-center rounded-full py-0.5 text-[10px] font-bold',
          padding,
          couponTypeClass(menu.couponType),
        )}
      >
        {couponTypeLabel(menu.couponType)}
      </span>
    ) : null;
  return (
    <div
      data-menu={menu.id}
      className={cx(
        'cursor-pointer rounded-lg border bg-background p-3 transition-colors hover:bg-muted/50 md:p-4',
        !listed && 'opacity-50',
      )}
      onClick={() => onNavigate(menu.id)}
    >
      {/* phone */}
      <div className="md:hidden">
        <div className="flex items-start gap-2">
          {arrows}
          {image ? (
            <img src={image} alt={menu.name} className="h-14 w-14 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-muted">
              <ImagePlus className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{menu.name}</span>
              {couponBadge('px-1.5')}
              {!listed ? (
                <Badge variant="secondary" className="shrink-0 text-xs">
                  非掲載
                </Badge>
              ) : null}
              {expired ? (
                <Badge variant="outline" className="shrink-0 text-xs">
                  期限切れ
                </Badge>
              ) : null}
            </div>
            {menu.description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{menu.description}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between border-t pt-2">
          <div className="text-sm text-muted-foreground">
            <span className="font-bold text-foreground">{formatCurrency(menu.price)}</span>
            <span className="mx-1.5">·</span>
            <span>{formatDuration(menu.durationMin)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              aria-label={listed ? '非掲載にする' : '掲載する'}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onToggleActive(menu);
              }}
            >
              {listed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              aria-label="編集"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(menu.id);
              }}
            >
              <SquarePen className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-destructive"
              aria-label="削除"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(menu.id);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* desktop */}
      <div className="hidden items-center justify-between gap-4 md:flex">
        <div className="flex items-center gap-3">
          {arrows}
          {image ? (
            <img src={image} alt={menu.name} className="h-16 w-16 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted">
              <ImagePlus className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{menu.name}</span>
              {couponBadge('px-2')}
              {!listed ? <Badge variant="secondary">非掲載</Badge> : null}
              {expired ? (
                <Badge variant="outline" className="text-xs">
                  期限切れ
                </Badge>
              ) : null}
              {menu.staffIds.length > 0 ? (
                <Badge variant="outline" className="text-xs">
                  {menu.staffIds.length}名対応
                </Badge>
              ) : null}
            </div>
            {menu.description ? (
              <p className="text-sm text-muted-foreground">{menu.description}</p>
            ) : null}
            <div className="mt-1 text-sm text-muted-foreground">{formatDuration(menu.durationMin)}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-lg font-bold">{formatCurrency(menu.price)}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onToggleActive(menu);
              }}
            >
              {listed ? '非掲載' : '掲載'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="編集"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(menu.id);
              }}
            >
              <SquarePen className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              aria-label="削除"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(menu.id);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** メニュー × 列 (スタッフ / 設備) の対応表 */
function Matrix({
  title,
  saving,
  onSave,
  canManage,
  columns,
  groups,
  colorOf,
  checked,
  onToggle,
}: {
  title: string;
  saving: boolean;
  onSave: () => void;
  canManage: boolean;
  columns: { id: string; name: string; sub?: string | null }[];
  groups: Map<string, EffectiveMenu[]>;
  colorOf: (group: string, menus: EffectiveMenu[]) => string;
  checked: Map<string, Set<string>>;
  onToggle: (menuId: string, columnId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="py-3 md:py-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onSave} disabled={saving || !canManage}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="sticky left-0 min-w-[200px] bg-muted/50 px-3 py-2 text-left font-medium">
                  メニュー
                </th>
                {columns.map((c) => (
                  <th
                    key={c.id}
                    className="min-w-[60px] whitespace-nowrap px-2 py-2 text-center font-medium"
                  >
                    <div className="text-xs">{c.name}</div>
                    {c.sub ? (
                      <div className="text-[10px] font-normal text-muted-foreground">{c.sub}</div>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(groups.entries()).map(([group, menus]) => (
                <Fragment key={group}>
                  <tr className="bg-muted/30">
                    <td
                      colSpan={columns.length + 1}
                      className="sticky left-0 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground"
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className="h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: colorOf(group, menus) }}
                        />
                        {group}
                      </div>
                    </td>
                  </tr>
                  {menus.map((m) => {
                    const set = checked.get(m.id);
                    const listed = isListed(m);
                    return (
                      <tr key={m.id} className={cx('border-b hover:bg-muted/20', !listed && 'opacity-50')}>
                        <td className="sticky left-0 max-w-[200px] bg-background px-3 py-2 text-xs">
                          <span className="truncate">{m.name}</span>
                          {!listed ? (
                            <span className="ml-1 text-[10px] text-muted-foreground">(非掲載)</span>
                          ) : null}
                        </td>
                        {columns.map((c) => {
                          const on = set?.has(c.id) ?? false;
                          return (
                            <td key={c.id} className="px-2 py-2 text-center">
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={on}
                                aria-label={`${m.name} × ${c.name}`}
                                disabled={!canManage}
                                className={cx(
                                  'flex h-6 w-6 items-center justify-center rounded-sm border transition-colors',
                                  on
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-muted-foreground/30 hover:border-primary/50',
                                )}
                                onClick={() => onToggle(m.id, c.id)}
                              >
                                {on ? <Check className="h-3 w-3" /> : null}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function toggleIn(prev: Map<string, Set<string>>, menuId: string, columnId: string) {
  const next = new Map(prev);
  const set = new Set(next.get(menuId) ?? []);
  if (set.has(columnId)) set.delete(columnId);
  else set.add(columnId);
  next.set(menuId, set);
  return next;
}

/** メニュー管理: 通常メニュー / クーポン の一覧、並び順、掲載、対応スタッフ・対応設備 */
export default function MenuList() {
  const { currentShopId: shopId, can, timezone } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = can('menu.manage');

  const menusQ = useMenus(shopId, true);
  const categoriesQ = useCategories(shopId ?? undefined);
  const staffQ = useStaffList({ shopId: shopId ?? undefined }, !!shopId);

  const [view, setView] = useState<View>('list');
  // 設備 = the equipment list of 店舗設定 › 設備 (name × quantity), in the same order; read when the
  // 対応設備 table is opened
  const equipmentQ = useEquipment(shopId, false, view === 'equipment-matrix');
  const [tab, setTab] = useState<MenuTab>(() => (params.get('tab') === 'coupon' ? 'coupon' : 'regular'));
  const [couponFilter, setCouponFilter] = useState<CouponFilter>('all');
  const [staffMatrix, setStaffMatrix] = useState<Map<string, Set<string>>>(new Map());
  const [equipmentMatrix, setEquipmentMatrix] = useState<Map<string, Set<string>>>(new Map());
  const [savingStaff, setSavingStaff] = useState(false);
  const [savingEquipment, setSavingEquipment] = useState(false);
  const [orderSaved, setOrderSaved] = useState(false);
  const orderTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(orderTimer.current), []);

  const menus = useMemo(() => menusQ.data ?? [], [menusQ.data]);
  const colors = useMemo(() => colorByCategoryName(categoriesQ.data), [categoriesQ.data]);
  const staff = useMemo(
    () =>
      (staffQ.data ?? [])
        .filter((s) => s.status === 'active')
        .map((s) => ({ id: s.id, name: s.display_name, sub: s.salonboard_name })),
    [staffQ.data],
  );
  // a menu is linked to an equipment by its name (the resource type of its units)
  const equipment = useMemo(
    () => (equipmentQ.data ?? []).map((e) => ({ id: e.name, name: e.name })),
    [equipmentQ.data],
  );

  const regular = useMemo(() => menus.filter((m) => !isCoupon(m)), [menus]);
  // coupons are one flat list: their own order first, whatever category they are in
  const coupons = useMemo(
    () => menus.filter(isCoupon).sort((a, b) => a.sortOrder - b.sortOrder),
    [menus],
  );
  const regularGroups = useMemo(() => groupMenus(regular), [regular]);
  const allGroups = useMemo(() => groupMenus(menus), [menus]);
  const colorOf = (group: string, list: EffectiveMenu[]) => groupColor(group, list, colors);

  const refresh = () => qc.invalidateQueries({ queryKey: catalogKeys.all });
  // today in the shop's timezone ('YYYY-MM-DD'), to mark coupons past their expiry date
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());

  const openStaffMatrix = () => {
    setStaffMatrix(new Map(menus.map((m) => [m.id, new Set(m.staffIds)])));
    setView('staff-matrix');
  };
  const openEquipmentMatrix = () => {
    setEquipmentMatrix(
      new Map(menus.map((m) => [m.id, new Set(m.resourceRequirements.map((r) => r.resourceType))])),
    );
    setView('equipment-matrix');
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('このメニューを削除しますか？')) return;
    try {
      await catalogApi.deleteMenuIfUnused(id);
      await refresh();
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        const message = e.message || 'このメニューは予約で使用されています。';
        if (window.confirm(`${message}\n\n非表示にしますか？（予約履歴は保持されます）`)) {
          try {
            await catalogApi.deleteMenu(id);
            await refresh();
          } catch (e2) {
            toast.error('メニューの削除に失敗しました', errorMessage(e2));
          }
        }
        return;
      }
      toast.error('メニューの削除に失敗しました', errorMessage(e));
    }
  };

  const handleToggle = async (m: EffectiveMenu) => {
    if (!shopId) return;
    try {
      await catalogApi.setListing(m.id, shopId, !isListed(m));
      await refresh();
    } catch (e) {
      toast.error('掲載状態の変更に失敗しました', errorMessage(e));
    }
  };

  const handleMove = async (list: EffectiveMenu[], index: number, direction: 'up' | 'down') => {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target]!, next[index]!];
    try {
      await catalogApi.reorderMenus(next.map((m, i) => ({ id: m.id, sortOrder: i })));
      await refresh();
      setOrderSaved(true);
      window.clearTimeout(orderTimer.current);
      orderTimer.current = window.setTimeout(() => setOrderSaved(false), 2000);
    } catch (e) {
      toast.error('並び順の保存に失敗しました', errorMessage(e));
      await refresh();
    }
  };

  const saveStaffMatrix = async () => {
    if (!shopId) return;
    setSavingStaff(true);
    try {
      const columns = staff.map((s) => s.id);
      await catalogApi.setStaffAssignments({
        shopId,
        staffIds: columns,
        assignments: [...staffMatrix.entries()].map(([menuId, set]) => ({
          menuId,
          staffIds: columns.filter((id) => set.has(id)),
        })),
      });
      await refresh();
      toast.success('保存しました');
    } catch (e) {
      toast.error('保存に失敗しました', errorMessage(e));
    } finally {
      setSavingStaff(false);
    }
  };

  const saveEquipmentMatrix = async () => {
    if (!shopId) return;
    setSavingEquipment(true);
    try {
      const columns = equipment.map((c) => c.id);
      await catalogApi.setEquipmentAssignments({
        shopId,
        resourceTypes: columns,
        assignments: [...equipmentMatrix.entries()].map(([menuId, set]) => ({
          menuId,
          resourceTypes: columns.filter((id) => set.has(id)),
        })),
      });
      await refresh();
      toast.success('保存しました');
    } catch (e) {
      toast.error('保存に失敗しました', errorMessage(e));
    } finally {
      setSavingEquipment(false);
    }
  };

  if (!shopId || menusQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  const rows = (list: EffectiveMenu[], onNavigate: (id: string) => void): ReactNode =>
    list.map((m, i) => (
      <MenuRow
        key={m.id}
        menu={m}
        isFirst={i === 0}
        isLast={i === list.length - 1}
        expired={!!m.expiryDate && m.expiryDate < today}
        disabled={!canManage}
        onMoveUp={() => void handleMove(list, i, 'up')}
        onMoveDown={() => void handleMove(list, i, 'down')}
        onToggleActive={(menu) => void handleToggle(menu)}
        onDelete={(id) => void handleDelete(id)}
        onNavigate={onNavigate}
      />
    ));

  const filteredCoupons = coupons.filter((m) => matchesFilter(m, couponFilter));

  return (
    <div className="sy-4 md:sy-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold md:text-2xl">メニュー管理</h1>
        <div className="flex items-center gap-2">
          <Button
            variant={view === 'staff-matrix' ? 'default' : 'outline'}
            size="sm"
            aria-label={view === 'staff-matrix' ? 'リスト表示' : '対応スタッフ'}
            onClick={() => (view !== 'staff-matrix' ? openStaffMatrix() : setView('list'))}
          >
            {view === 'staff-matrix' ? <List className="mr-1 h-4 w-4" /> : <Grid3x3 className="mr-1 h-4 w-4" />}
            <span className="hidden sm:inline">{view === 'staff-matrix' ? 'リスト表示' : '対応スタッフ'}</span>
          </Button>
          <Button
            variant={view === 'equipment-matrix' ? 'default' : 'outline'}
            size="sm"
            aria-label={view === 'equipment-matrix' ? 'リスト表示' : '対応設備'}
            onClick={() => (view !== 'equipment-matrix' ? openEquipmentMatrix() : setView('list'))}
          >
            {view === 'equipment-matrix' ? <List className="mr-1 h-4 w-4" /> : <Wrench className="mr-1 h-4 w-4" />}
            <span className="hidden sm:inline">{view === 'equipment-matrix' ? 'リスト表示' : '対応設備'}</span>
          </Button>
          <Link to="/app/menus/categories" className={buttonVariants('outline', 'sm')} aria-label="カテゴリ管理">
            <Palette className="mr-1 h-4 w-4 md:mr-2" />
            <span className="hidden sm:inline">カテゴリ管理</span>
            <span className="sm:hidden">カテゴリ</span>
          </Link>
        </div>
      </div>

      {view === 'staff-matrix' ? (
        <Matrix
          title="対応スタッフ設定"
          saving={savingStaff}
          onSave={() => void saveStaffMatrix()}
          canManage={canManage}
          columns={staff}
          groups={allGroups}
          colorOf={colorOf}
          checked={staffMatrix}
          onToggle={(menuId, staffId) => setStaffMatrix((prev) => toggleIn(prev, menuId, staffId))}
        />
      ) : view === 'equipment-matrix' ? (
        <Matrix
          title="対応設備設定"
          saving={savingEquipment}
          onSave={() => void saveEquipmentMatrix()}
          canManage={canManage}
          columns={equipment}
          groups={allGroups}
          colorOf={colorOf}
          checked={equipmentMatrix}
          onToggle={(menuId, type) => setEquipmentMatrix((prev) => toggleIn(prev, menuId, type))}
        />
      ) : (
        <>
          <div className="border-b">
            <div className="flex items-center gap-2" role="tablist" aria-label="メニューの種類">
              {(
                [
                  ['regular', '通常メニュー', regular.length],
                  ['coupon', 'クーポン', coupons.length],
                ] as const
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className={cx(
                    'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                    tab === key
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setTab(key)}
                >
                  {label}
                  <Badge variant="secondary" className="ml-2 text-xs">
                    {count}
                  </Badge>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!canManage}
              onClick={() => navigate(`/app/menus/new?type=${tab === 'coupon' ? 'coupon' : 'regular'}`)}
            >
              <Plus className="mr-1 h-4 w-4" />
              {tab === 'coupon' ? '新規クーポン' : '新規メニュー'}
            </Button>
          </div>

          {tab === 'coupon' ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {COUPON_FILTERS.map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={couponFilter === key}
                    className={cx(
                      'rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                      couponFilter === key
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setCouponFilter(key)}
                  >
                    {label}
                    <span className="ml-1.5 text-xs opacity-70">
                      {coupons.filter((m) => matchesFilter(m, key)).length}
                    </span>
                  </button>
                ))}
              </div>
              {filteredCoupons.length === 0 ? (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    クーポンがありません
                  </CardContent>
                </Card>
              ) : (
                <div className="sy-2 md:sy-3">
                  {rows(filteredCoupons, (id) => navigate(`/app/menus/${id}?type=coupon`))}
                </div>
              )}
            </>
          ) : regularGroups.size === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">メニューがありません</CardContent>
            </Card>
          ) : (
            <div className="sy-4 md:sy-6">
              {Array.from(regularGroups.entries()).map(([group, list]) => (
                <Card key={group}>
                  <CardHeader className="py-3 md:py-6">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-4 w-4 shrink-0 rounded-full"
                        style={{ backgroundColor: colorOf(group, list) }}
                      />
                      <CardTitle className="text-base md:text-lg">{group}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="sy-2 md:sy-3">{rows(list, (id) => navigate(`/app/menus/${id}`))}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {orderSaved ? (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-4 py-2 text-sm text-background shadow-lg"
        >
          並び順を保存しました
        </div>
      ) : null}
    </div>
  );
}
