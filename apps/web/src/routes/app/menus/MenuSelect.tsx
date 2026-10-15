import { Check, ChevronLeft, ImagePlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useCategories, useMenus } from '../../../api/catalog';
import { sameOriginBlobUrl } from '../../../api/files';
import { Button } from '../../../components/shad';
import { useAuth } from '../../../lib/auth';
import { cx } from '../../../lib/cn';
import { formatCurrency, formatDuration, type PickedMenu } from '../reservations/model';

/** メニューを選択: pick one or more menus for a reservation, grouped by category */
export default function MenuSelect() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { currentShopId: shopId } = useAuth();
  const staffId = params.get('staff_id');
  const menusQ = useMenus(shopId);
  const categoriesQ = useCategories(shopId ?? undefined);
  const [picked, setPicked] = useState<Map<string, PickedMenu>>(new Map());

  useEffect(() => {
    const raw = params.get('selected');
    if (!raw) return;
    try {
      setPicked(new Map((JSON.parse(raw) as PickedMenu[]).map((m) => [m.id, m])));
    } catch {
      /* ignore a malformed hand-over */
    }
  }, [params]);

  const menus = useMemo(() => {
    const active = (menusQ.data ?? []).filter((m) => m.status === 'active');
    return staffId ? active.filter((m) => m.staffIds.length === 0 || m.staffIds.includes(staffId)) : active;
  }, [menusQ.data, staffId]);

  // group by the category name up to a full-width colon ("まつげ：上" and "まつげ：下" share a group)
  const { groups, colors } = useMemo(() => {
    const colorByName = new Map((categoriesQ.data ?? []).map((c) => [c.name, c.color]));
    const g = new Map<string, typeof menus>();
    const c: Record<string, string> = {};
    for (const m of menus) {
      const full = m.categoryName || 'その他';
      const i = full.indexOf('：');
      const name = i > 0 ? full.substring(0, i) : full;
      if (!g.has(name)) g.set(name, []);
      g.get(name)!.push(m);
      const color = colorByName.get(full) ?? colorByName.get(name);
      if (color) c[name] = color;
    }
    return { groups: g, colors: c };
  }, [menus, categoriesQ.data]);

  const selected = Array.from(picked.values());
  const totalDuration = selected.reduce((sum, m) => sum + m.duration, 0);
  const totalPrice = selected.reduce((sum, m) => sum + m.price, 0);

  return (
    <div className="pb-24">
      <div className="mb-4 flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="戻る" onClick={() => navigate(-1)}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold md:text-2xl">メニューを選択</h1>
      </div>

      {menusQ.isLoading ? (
        <div className="py-12 text-center text-muted-foreground">読み込み中...</div>
      ) : menus.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">対応可能なメニューがありません</div>
      ) : (
        <div className="sy-4">
          {Array.from(groups.entries()).map(([name, list]) => (
            <div key={name}>
              <div className="mb-2 flex items-center gap-2">
                {colors[name] ? (
                  <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: colors[name] }} />
                ) : null}
                <h2 className="text-sm font-semibold text-muted-foreground">{name}</h2>
              </div>
              <div className="rounded-md border">
                {list.map((m, i) => {
                  const on = picked.has(m.id);
                  return (
                    <div
                      key={m.id}
                      role="checkbox"
                      aria-checked={on}
                      aria-label={m.name}
                      tabIndex={0}
                      className={cx(
                        'flex cursor-pointer items-start gap-3 p-3 transition-colors',
                        i < list.length - 1 && 'border-b',
                        on ? 'bg-primary/10' : 'hover:bg-muted/50',
                      )}
                      onClick={() =>
                        setPicked((prev) => {
                          const next = new Map(prev);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.set(m.id, { id: m.id, name: m.name, duration: m.durationMin, price: m.price });
                          return next;
                        })
                      }
                    >
                      <div
                        className={cx(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border transition-colors',
                          on ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                        )}
                      >
                        {on ? <Check className="h-3.5 w-3.5" /> : null}
                      </div>
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
                        {m.imageUrl ? (
                          <img
                            src={sameOriginBlobUrl(m.imageUrl)}
                            alt={m.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <ImagePlus className="h-5 w-5 text-muted-foreground/50" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium leading-tight">{m.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatDuration(m.durationMin)} / {formatCurrency(m.price)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background p-4">
        <Button
          className="w-full"
          disabled={picked.size === 0}
          onClick={() => navigate(`/app/calendar/new?menu_data=${encodeURIComponent(JSON.stringify(selected))}`)}
        >
          {picked.size > 0
            ? `決定 (${picked.size}件 / ${formatDuration(totalDuration)} / ${formatCurrency(totalPrice)})`
            : 'メニューを選択してください'}
        </Button>
      </div>
    </div>
  );
}
