"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, Scissors, Check, Search, X } from "lucide-react";
import { menus, staffMenus as staffMenusApi, type Menu, type StaffMenu } from "@/lib/api";
import { formatPrice, formatDuration, getImageUrl, cn } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import { Button } from "@/components/ui/button";

type SelectedMenu = { id: string; name: string; duration: number; price: number };

function MenuSelectContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentStore, staff } = useStore();

  const staffId = searchParams.get("staff_id");

  const [menuList, setMenuList] = useState<Menu[]>([]);
  const [myMenus, setMyMenus] = useState<StaffMenu[]>([]);
  const [byCategory, setByCategory] = useState<Record<string, Menu[]>>({});
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Map<string, SelectedMenu>>(new Map());
  const [searchQuery, setSearchQuery] = useState("");

  // Pre-select menus from URL params (when editing existing selection)
  useEffect(() => {
    const preselected = searchParams.get("selected");
    if (preselected) {
      try {
        const parsed = JSON.parse(decodeURIComponent(preselected)) as SelectedMenu[];
        const map = new Map<string, SelectedMenu>();
        for (const m of parsed) map.set(m.id, m);
        setSelected(map);
      } catch { /* ignore */ }
    }
  }, [searchParams]);

  const fetchMenus = useCallback(async () => {
    if (!currentStore) return;
    setLoading(true);
    try {
      const [result, myResult] = await Promise.all([
        menus.list(currentStore.id, false),
        staffMenusApi.list(),
      ]);

      // Personal menus
      setMyMenus(myResult.menus.filter((m) => m.is_active));

      // Store menus: show active menus + inactive menus assigned to this staff
      const effectiveStaffId = staffId || staff?.id;
      const storeMenus = result.menus.filter((m) => {
        const isAssignedToStaff = effectiveStaffId && m.assigned_staff_ids?.includes(effectiveStaffId);
        if (!m.is_active) {
          // Show inactive menus only if explicitly assigned to this staff
          return !!isAssignedToStaff;
        }
        // Show active menus: only if assigned to this staff
        if (!effectiveStaffId) return true;
        return m.assigned_staff_ids?.includes(effectiveStaffId) ?? false;
      });

      setMenuList(storeMenus);
      setCategoryColors(result.categoryColors || {});

      const grouped: Record<string, Menu[]> = {};
      for (const m of storeMenus) {
        const cat = m.category || "その他";
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(m);
      }
      setByCategory(grouped);

      // Filter pre-selected menus: remove any that aren't in the visible menu lists
      const visibleIds = new Set([
        ...storeMenus.map(m => m.id),
        ...myResult.menus.filter(m => m.is_active).map(m => m.id),
      ]);
      setSelected(prev => {
        let changed = false;
        const next = new Map(prev);
        for (const id of next.keys()) {
          if (!visibleIds.has(id)) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    } catch (error) {
      console.error("Failed to fetch menus:", error);
    } finally {
      setLoading(false);
    }
  }, [currentStore, staff, staffId]);

  useEffect(() => {
    fetchMenus();
  }, [fetchMenus]);

  const toggleMenu = (m: Menu | StaffMenu) => {
    const key = m.id;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, { id: key, name: m.name, duration: m.duration, price: m.price });
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const menuData = Array.from(selected.values());
    const returnTo = searchParams.get("return");
    const reservationId = searchParams.get("reservation_id");
    if (returnTo === "edit" && reservationId) {
      router.push(
        `/reservations/${reservationId}/edit?menu_data=${encodeURIComponent(JSON.stringify(menuData))}`
      );
    } else {
      const returnDate = searchParams.get("return_date");
      const returnTime = searchParams.get("return_time");
      const dtParams = returnDate ? `&date=${encodeURIComponent(returnDate)}&time=${encodeURIComponent(returnTime || "")}` : "";
      router.push(
        `/reservations/new?menu_data=${encodeURIComponent(JSON.stringify(menuData))}${dtParams}`
      );
    }
  };

  const totalDuration = Array.from(selected.values()).reduce((s, m) => s + m.duration, 0);
  const totalPrice = Array.from(selected.values()).reduce((s, m) => s + m.price, 0);

  const query = searchQuery.trim().toLowerCase();

  // Filter personal menus
  const filteredMyMenus = query
    ? myMenus.filter((m) => m.name.toLowerCase().includes(query))
    : myMenus;

  // Filter store menus by category
  const filteredByCategory: Record<string, Menu[]> = {};
  for (const [cat, items] of Object.entries(byCategory)) {
    const filtered = query
      ? items.filter((m) => m.name.toLowerCase().includes(query))
      : items;
    if (filtered.length > 0) filteredByCategory[cat] = filtered;
  }
  const categories = Object.keys(filteredByCategory);
  const hasAnyMenu = filteredMyMenus.length > 0 || categories.length > 0;

  return (
    <div className="pb-24">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold">メニューを選択</h1>
      </div>

      {/* Search */}
      {!loading && (menuList.length > 0 || myMenus.length > 0) && (
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="メニュー名で検索"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-9 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">読み込み中...</div>
      ) : menuList.length === 0 && myMenus.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          対応可能なメニューがありません
        </div>
      ) : !hasAnyMenu ? (
        <div className="py-12 text-center text-muted-foreground">
          「{searchQuery}」に一致するメニューはありません
        </div>
      ) : (
        <div className="space-y-4">
          {/* Personal menus */}
          {filteredMyMenus.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full bg-primary" />
                <h2 className="text-sm font-semibold text-muted-foreground">マイメニュー</h2>
              </div>
              <div className="rounded-md border">
                {filteredMyMenus.map((m, i) => {
                  const isSelected = selected.has(m.id);
                  return (
                    <div
                      key={m.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 p-3 transition-colors",
                        i < filteredMyMenus.length - 1 && "border-b",
                        isSelected
                          ? "bg-primary/10"
                          : "hover:bg-muted/50"
                      )}
                      onClick={() => toggleMenu(m)}
                    >
                      <div className={cn(
                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input"
                      )}>
                        {isSelected && <Check className="h-3.5 w-3.5" />}
                      </div>
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
                        <div className="flex h-full w-full items-center justify-center">
                          <Scissors className="h-5 w-5 text-muted-foreground/50" />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-tight break-words">{m.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatDuration(m.duration)} / {formatPrice(m.price)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Store menus */}
          {categories.map((cat) => (
            <div key={cat}>
              <div className="mb-2 flex items-center gap-2">
                {categoryColors[cat] && (
                  <span
                    className="inline-block h-3 w-3 rounded-full"
                    style={{ backgroundColor: categoryColors[cat] }}
                  />
                )}
                <h2 className="text-sm font-semibold text-muted-foreground">{cat}</h2>
              </div>
              <div className="rounded-md border">
                {filteredByCategory[cat].map((m, i) => {
                  const isSelected = selected.has(m.id);
                  return (
                    <div
                      key={m.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 p-3 transition-colors",
                        i < filteredByCategory[cat].length - 1 && "border-b",
                        isSelected
                          ? "bg-primary/10"
                          : "hover:bg-muted/50"
                      )}
                      onClick={() => toggleMenu(m)}
                    >
                      <div className={cn(
                        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input"
                      )}>
                        {isSelected && <Check className="h-3.5 w-3.5" />}
                      </div>
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
                        {m.image_url ? (
                          <img
                            src={getImageUrl(m.image_url) || ""}
                            alt={m.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <Scissors className="h-5 w-5 text-muted-foreground/50" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-tight break-words">{m.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatDuration(m.duration)} / {formatPrice(m.price)}
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

      {/* Fixed bottom confirm button */}
      <div className="fixed bottom-16 md:bottom-0 left-0 right-0 border-t bg-background p-4 z-40">
        <Button
          className="w-full"
          disabled={selected.size === 0}
          onClick={handleConfirm}
        >
          {selected.size > 0
            ? `決定 (${selected.size}件 / ${formatDuration(totalDuration)} / ${formatPrice(totalPrice)})`
            : "メニューを選択してください"}
        </Button>
      </div>
    </div>
  );
}

export default function MenusPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">読み込み中...</div>}>
      <MenuSelectContent />
    </Suspense>
  );
}
