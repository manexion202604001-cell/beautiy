"use client";

import { Menu } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

type MenuSelectorProps = {
  menus: Menu[];
  selectedMenuIds: string[];
  onSelectionChange: (menuIds: string[]) => void;
  staffId?: string;
  categoryColors?: Record<string, string>;
};

export function MenuSelector({
  menus,
  selectedMenuIds,
  onSelectionChange,
  staffId,
  categoryColors = {},
}: MenuSelectorProps) {
  // Filter menus assigned to this staff member
  const availableMenus = staffId
    ? menus.filter(
        (m) =>
          m.is_active &&
          m.assigned_staff_ids &&
          m.assigned_staff_ids.includes(staffId)
      )
    : menus.filter((m) => m.is_active);

  // Group by category
  const byCategory: Record<string, Menu[]> = {};
  for (const menu of availableMenus) {
    const cat = menu.category || "その他";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(menu);
  }

  const totalPrice = availableMenus
    .filter((m) => selectedMenuIds.includes(m.id))
    .reduce((sum, m) => sum + m.price, 0);

  const toggleMenu = (menuId: string) => {
    if (selectedMenuIds.includes(menuId)) {
      onSelectionChange(selectedMenuIds.filter((id) => id !== menuId));
    } else {
      onSelectionChange([...selectedMenuIds, menuId]);
    }
  };

  if (availableMenus.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        担当メニューが設定されていません
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {Object.entries(byCategory).map(([category, categoryMenus]) => (
        <div key={category}>
          <div className="flex items-center gap-2 mb-2">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: categoryColors[category] || "#999" }}
            />
            <span className="text-xs font-medium text-muted-foreground">
              {category}
            </span>
          </div>
          <div className="space-y-1">
            {categoryMenus.map((menu) => {
              const isSelected = selectedMenuIds.includes(menu.id);
              return (
                <button
                  key={menu.id}
                  type="button"
                  onClick={() => toggleMenu(menu.id)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-colors",
                    isSelected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className={cn(
                        "w-5 h-5 rounded border flex items-center justify-center flex-shrink-0",
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-muted-foreground/30"
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </div>
                    <span className="text-sm truncate">{menu.name}</span>
                  </div>
                  <span className="text-sm text-muted-foreground flex-shrink-0 ml-2">
                    {menu.price_tilde ? "~" : ""}
                    {menu.price.toLocaleString()}円
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Total */}
      {selectedMenuIds.length > 0 && (
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-sm font-medium">
            合計（{selectedMenuIds.length}件）
          </span>
          <span className="text-base font-bold">
            {totalPrice.toLocaleString()}円
          </span>
        </div>
      )}
    </div>
  );
}
