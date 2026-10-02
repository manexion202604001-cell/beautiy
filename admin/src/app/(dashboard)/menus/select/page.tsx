"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, Scissors, Check, ImagePlus } from "lucide-react";
import { menus, type Menu } from "@/lib/api";
import { formatPrice, formatDuration, getImageUrl, cn } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";
import { Button } from "@/components/ui/button";

type SelectedMenu = { id: string; name: string; duration: number; price: number };

function MenuSelectContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentStore } = useStore();

  const staffId = searchParams.get("staff_id");

  const [menuList, setMenuList] = useState<Menu[]>([]);
  const [byCategory, setByCategory] = useState<Record<string, Menu[]>>({});
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Map<string, SelectedMenu>>(new Map());

  // Pre-select menus from URL params
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
      const result = await menus.list(currentStore.id);
      const activeMenus = result.menus.filter((m) => m.is_active);
      const staffMenus = staffId
        ? activeMenus.filter(
            (m) => m.assigned_staff_ids?.includes(staffId)
          )
        : activeMenus;

      setMenuList(staffMenus);
      setCategoryColors(result.categoryColors || {});

      const grouped: Record<string, Menu[]> = {};
      for (const m of staffMenus) {
        const cat = m.category || "その他";
        const parentIdx = cat.indexOf("：");
        const parent = parentIdx > 0 ? cat.substring(0, parentIdx) : cat;
        if (!grouped[parent]) grouped[parent] = [];
        grouped[parent].push(m);
      }
      setByCategory(grouped);
    } catch (error) {
      console.error("Failed to fetch menus:", error);
    } finally {
      setLoading(false);
    }
  }, [currentStore, staffId]);

  useEffect(() => {
    fetchMenus();
  }, [fetchMenus]);

  const toggleMenu = (m: Menu) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(m.id)) {
        next.delete(m.id);
      } else {
        next.set(m.id, { id: m.id, name: m.name, duration: m.duration, price: m.price });
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const menuData = Array.from(selected.values());
    router.push(
      `/reservations/new?menu_data=${encodeURIComponent(JSON.stringify(menuData))}`
    );
  };

  const totalDuration = Array.from(selected.values()).reduce((s, m) => s + m.duration, 0);
  const totalPrice = Array.from(selected.values()).reduce((s, m) => s + m.price, 0);
  const categories = Object.keys(byCategory);

  return (
    <div className="pb-24">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl md:text-2xl font-bold">メニューを選択</h1>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">読み込み中...</div>
      ) : menuList.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          対応可能なメニューがありません
        </div>
      ) : (
        <div className="space-y-4">
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
                {byCategory[cat].map((m, i) => {
                  const isSelected = selected.has(m.id);
                  return (
                    <div
                      key={m.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 p-3 transition-colors",
                        i < byCategory[cat].length - 1 && "border-b",
                        isSelected
                          ? "bg-primary/10"
                          : "hover:bg-muted/50"
                      )}
                      onClick={() => toggleMenu(m)}
                    >
                      {/* Checkbox */}
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
                            <ImagePlus className="h-5 w-5 text-muted-foreground/50" />
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
      <div className="fixed bottom-0 left-0 right-0 border-t bg-background p-4 z-40">
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

export default function MenuSelectPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">読み込み中...</div>}>
      <MenuSelectContent />
    </Suspense>
  );
}
