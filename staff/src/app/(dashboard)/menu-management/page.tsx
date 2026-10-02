"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Edit, Trash2, Eye, EyeOff, ImagePlus, ChevronUp, ChevronDown, Grid3X3, List, Check, Wrench, Palette } from "lucide-react";
import { menus, staffApi, equipment as equipmentApi, type Menu, type Staff, type Equipment } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { formatPrice, formatDuration, getImageUrl, cn } from "@/lib/utils";

type ViewTab = "regular" | "coupon";

const getParentName = (category: string) => {
  const idx = category.indexOf("：");
  return idx > 0 ? category.substring(0, idx) : category;
};

function MenuItem({
  menu,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onToggleActive,
  onDelete,
  onNavigate,
}: {
  menu: Menu;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleActive: (menu: Menu) => void;
  onDelete: (id: string) => void;
  onNavigate: (id: string) => void;
}) {
  return (
    <div
      className={`rounded-lg border p-3 md:p-4 cursor-pointer hover:bg-muted/50 transition-colors bg-background ${!menu.is_active ? "opacity-50" : ""}`}
      onClick={() => onNavigate(menu.id)}
    >
      {/* モバイル */}
      <div className="md:hidden">
        <div className="flex items-start gap-2">
          <div className="flex flex-col shrink-0">
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isFirst}
              onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
            >
              <ChevronUp className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isLast}
              onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
            >
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>
          {menu.image_url ? (
            <img src={getImageUrl(menu.image_url) || ""} alt={menu.name} className="h-14 w-14 rounded-lg object-cover shrink-0" />
          ) : (
            <div className="h-14 w-14 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <ImagePlus className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{menu.name}</span>
              {menu.coupon_type && (
                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold shrink-0 ${
                  menu.coupon_type === "new" ? "bg-blue-100 text-blue-700" : menu.coupon_type === "repeat" ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
                }`}>
                  {menu.coupon_type === "new" ? "新規" : menu.coupon_type === "repeat" ? "再来" : "全員"}
                </span>
              )}
              {!menu.is_active && <Badge variant="secondary" className="text-xs shrink-0">非掲載</Badge>}
            </div>
            {menu.description && <p className="text-xs text-muted-foreground mt-0.5">{menu.description}</p>}
          </div>
        </div>
        <div className="flex items-center justify-between mt-2 pt-2 border-t">
          <div className="text-sm text-muted-foreground">
            <span className="font-bold text-foreground">{formatPrice(menu.price)}</span>
            <span className="mx-1.5">·</span>
            <span>{formatDuration(menu.duration)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onToggleActive(menu); }}>
              {menu.is_active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={(e) => { e.stopPropagation(); onNavigate(menu.id); }}>
              <Edit className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(menu.id); }}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
      {/* デスクトップ */}
      <div className="hidden md:flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex flex-col shrink-0">
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isFirst}
              onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
            >
              <ChevronUp className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="p-2 -m-1 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
              disabled={isLast}
              onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
            >
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>
          {menu.image_url ? (
            <img src={getImageUrl(menu.image_url) || ""} alt={menu.name} className="h-16 w-16 rounded-lg object-cover shrink-0" />
          ) : (
            <div className="h-16 w-16 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <ImagePlus className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{menu.name}</span>
              {menu.coupon_type && (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  menu.coupon_type === "new" ? "bg-blue-100 text-blue-700" : menu.coupon_type === "repeat" ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"
                }`}>
                  {menu.coupon_type === "new" ? "新規" : menu.coupon_type === "repeat" ? "再来" : "全員"}
                </span>
              )}
              {!menu.is_active && <Badge variant="secondary">非掲載</Badge>}
              {menu.assigned_staff_ids && menu.assigned_staff_ids.length > 0 && (
                <Badge variant="outline" className="text-xs">{menu.assigned_staff_ids.length}名対応</Badge>
              )}
            </div>
            {menu.description && <p className="text-sm text-muted-foreground ">{menu.description}</p>}
            <div className="mt-1 text-sm text-muted-foreground">{formatDuration(menu.duration)}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-lg font-bold">{formatPrice(menu.price)}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onToggleActive(menu); }}>
              {menu.is_active ? "非掲載" : "掲載"}
            </Button>
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onNavigate(menu.id); }}>
              <Edit className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={(e) => { e.stopPropagation(); onDelete(menu.id); }}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MenuManagementPage() {
  const router = useRouter();
  const { currentStore, staff: currentStaff } = useStore();
  const [menuList, setMenuList] = useState<Menu[]>([]);
  const [categoryColors, setCategoryColors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [equipmentList, setEquipmentList] = useState<Equipment[]>([]);
  const [viewMode, setViewMode] = useState<"list" | "staff-matrix" | "equipment-matrix">("list");
  const [matrixChanges, setMatrixChanges] = useState<Map<string, Set<string>>>(new Map());
  const [matrixInitial, setMatrixInitial] = useState<Map<string, Set<string>>>(new Map());
  const [matrixSaving, setMatrixSaving] = useState(false);
  const [equipmentMatrixChanges, setEquipmentMatrixChanges] = useState<Map<string, Set<string>>>(new Map());
  const [equipmentMatrixSaving, setEquipmentMatrixSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>("regular");
  const [couponFilter, setCouponFilter] = useState<"all" | "new" | "repeat" | "everyone">("all");
  const [matrixStaffFilter, setMatrixStaffFilter] = useState<"all" | "mine">("all");


  useEffect(() => {
    if (!currentStore) return;
    fetchMenus();
    fetchStaff();
    fetchEquipment();
  }, [currentStore?.id]);

  const fetchStaff = async () => {
    try {
      const { staff: data } = await staffApi.list(currentStore?.id);
      setStaffList(data.filter(s => s.is_active && s.role !== "system_admin"));
    } catch (error) {
      console.error("Failed to fetch staff:", error);
    }
  };

  const fetchEquipment = async () => {
    try {
      const { equipment } = await equipmentApi.list(currentStore?.id);
      setEquipmentList(equipment);
    } catch (error) {
      console.error("Failed to fetch equipment:", error);
    }
  };

  const fetchMenus = async () => {
    try {
      const { menus: data, categoryColors: colors } = await menus.list(currentStore?.id, false);
      setMenuList(data);
      setCategoryColors(colors);
      return data;
    } catch (error) {
      console.error("Failed to fetch menus:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("このメニューを削除しますか？")) return;
    try {
      await menus.delete(id);
      await fetchMenus();
    } catch (error: unknown) {
      if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 409) {
        const msg = "message" in error ? String((error as Record<string, unknown>).message) : "このメニューは予約で使用されています。";
        if (confirm(`${msg}\n\n非表示にしますか？（予約履歴は保持されます）`)) {
          try {
            await menus.delete(id, true);
            await fetchMenus();
          } catch (e) {
            console.error("Failed to soft delete menu:", e);
          }
        }
        return;
      }
      console.error("Failed to delete menu:", error);
    }
  };

  const handleToggleActive = async (menu: Menu) => {
    try {
      await menus.update(menu.id, { is_active: menu.is_active ? 0 : 1 });
      await fetchMenus();
    } catch (error) {
      console.error("Failed to toggle menu:", error);
    }
  };

  const handleMove = useCallback(async (categoryMenus: Menu[], index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= categoryMenus.length) return;

    const reordered = [...categoryMenus];
    [reordered[index], reordered[newIndex]] = [reordered[newIndex], reordered[index]];
    const reorderedIds = new Set(reordered.map(m => m.id));

    setMenuList(prev => {
      const result: Menu[] = [];
      let inserted = false;
      for (const m of prev) {
        if (reorderedIds.has(m.id)) {
          if (!inserted) {
            result.push(...reordered.map((rm, i) => ({ ...rm, sort_order: i })));
            inserted = true;
          }
        } else {
          result.push(m);
        }
      }
      return result;
    });

    const items = reordered.map((m, i) => ({ id: m.id, sort_order: i }));
    try {
      await menus.reorder(items);
    } catch (error) {
      console.error("Failed to reorder:", error);
      await fetchMenus();
    }
  }, []);

  // Staff matrix
  const initMatrixFromMenus = (list?: Menu[]) => {
    const source = list ?? menuList;
    const map = new Map<string, Set<string>>();
    const initial = new Map<string, Set<string>>();
    for (const menu of source) {
      map.set(menu.id, new Set(menu.assigned_staff_ids || []));
      initial.set(menu.id, new Set(menu.assigned_staff_ids || []));
    }
    setMatrixChanges(map);
    setMatrixInitial(initial);
  };

  const toggleMatrixCell = (menuId: string, staffId: string) => {
    setMatrixChanges((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(menuId) || []);
      if (current.has(staffId)) current.delete(staffId);
      else current.add(staffId);
      next.set(menuId, current);
      return next;
    });
  };

  // Detect if matrix has changes from initial state
  const matrixHasChanges = (() => {
    for (const [menuId, currentSet] of matrixChanges) {
      const initialSet = matrixInitial.get(menuId) || new Set();
      if (currentSet.size !== initialSet.size) return true;
      for (const id of currentSet) {
        if (!initialSet.has(id)) return true;
      }
    }
    return false;
  })();

  const handleMatrixSave = async () => {
    if (!currentStore) return;
    setMatrixSaving(true);
    try {
      const isSelfOnly = currentStaff?.role === 'staff';
      const assignments = [...matrixChanges.entries()].map(([menu_id, staffSet]) => ({
        menu_id, staff_ids: [...staffSet],
      }));
      await menus.bulkUpdateStaffAssignments(currentStore.id, assignments, isSelfOnly);
      const updated = await fetchMenus();
      if (updated) initMatrixFromMenus(updated);
    } catch (error) {
      console.error("Failed to save:", error);
      alert("保存に失敗しました");
    } finally {
      setMatrixSaving(false);
    }
  };

  // Equipment matrix
  const initEquipmentMatrixFromMenus = (list?: Menu[]) => {
    const source = list ?? menuList;
    const map = new Map<string, Set<string>>();
    for (const menu of source) {
      map.set(menu.id, new Set(menu.assigned_equipment_ids || []));
    }
    setEquipmentMatrixChanges(map);
  };

  const toggleEquipmentMatrixCell = (menuId: string, equipmentId: string) => {
    setEquipmentMatrixChanges((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(menuId) || []);
      if (current.has(equipmentId)) current.delete(equipmentId);
      else current.add(equipmentId);
      next.set(menuId, current);
      return next;
    });
  };

  const handleEquipmentMatrixSave = async () => {
    if (!currentStore) return;
    setEquipmentMatrixSaving(true);
    try {
      const assignments = [...equipmentMatrixChanges.entries()].map(([menu_id, eqSet]) => ({
        menu_id, equipment_ids: [...eqSet],
      }));
      await menus.bulkUpdateEquipmentAssignments(currentStore.id, assignments);
      await fetchMenus();
      alert("保存しました");
    } catch (error) {
      console.error("Failed to save:", error);
      alert("保存に失敗しました");
    } finally {
      setEquipmentMatrixSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  const regularMenus = menuList.filter(m => m.menu_type !== "coupon");
  const couponMenus = menuList.filter(m => m.menu_type === "coupon");

  const groupByParentCategory = (items: Menu[]) => {
    const grouped: Record<string, Menu[]> = {};
    for (const m of items) {
      const parent = getParentName(m.category);
      if (!grouped[parent]) grouped[parent] = [];
      grouped[parent].push(m);
    }
    return grouped;
  };

  const regularByCategory = groupByParentCategory(regularMenus);
  const regularCategoryKeys = Object.keys(regularByCategory);
  const allByParentCategory = groupByParentCategory(menuList);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="space-y-3">
        <h1 className="text-xl md:text-2xl font-bold">メニュー管理</h1>
        <div className="flex items-center justify-between">
          <Link href="/my-menus">
            <Button variant="outline" size="sm">マイメニュー</Button>
          </Link>
          <div className="flex items-center gap-2">
          <Button
            variant={viewMode === "staff-matrix" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (viewMode !== "staff-matrix") {
                initMatrixFromMenus();
                setViewMode("staff-matrix");
              } else {
                setViewMode("list");
              }
            }}
          >
            {viewMode === "staff-matrix" ? <List className="mr-1 h-4 w-4" /> : <Grid3X3 className="mr-1 h-4 w-4" />}
            <span className="hidden sm:inline">{viewMode === "staff-matrix" ? "リスト表示" : "対応スタッフ"}</span>
          </Button>
          <Button
            variant={viewMode === "equipment-matrix" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (viewMode !== "equipment-matrix") {
                initEquipmentMatrixFromMenus();
                setViewMode("equipment-matrix");
              } else {
                setViewMode("list");
              }
            }}
          >
            {viewMode === "equipment-matrix" ? <List className="mr-1 h-4 w-4" /> : <Wrench className="mr-1 h-4 w-4" />}
            <span className="hidden sm:inline">{viewMode === "equipment-matrix" ? "リスト表示" : "対応設備"}</span>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/menu-management/categories">
              <Palette className="mr-1 md:mr-2 h-4 w-4" />
              <span className="hidden sm:inline">カテゴリ管理</span>
              <span className="sm:hidden">カテゴリ</span>
            </Link>
          </Button>
          </div>
        </div>
      </div>

      {viewMode === "staff-matrix" ? (<>
        <Card>
          <CardHeader className="py-3 md:py-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">対応スタッフ設定</CardTitle>
              <Button
                size="sm"
                variant={matrixStaffFilter === "mine" ? "default" : "outline"}
                className="text-xs h-7 px-2"
                onClick={() => setMatrixStaffFilter(matrixStaffFilter === "mine" ? "all" : "mine")}
              >
                自分のみ
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-auto max-h-[calc(100vh-220px)]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b bg-muted/50">
                    <th className="sticky left-0 z-20 bg-muted/50 px-3 py-2 text-left font-medium min-w-[200px]">メニュー</th>
                    {(matrixStaffFilter === "mine" ? staffList.filter(s => s.id === currentStaff?.id) : staffList).map((s) => (
                      <th key={s.id} className="px-2 py-2 text-center font-medium whitespace-nowrap min-w-[60px]">
                        <div className="text-xs">{s.nickname || s.name}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(allByParentCategory).map(([category, catMenus]) => (
                    <>
                      <tr key={`cat-${category}`} className="bg-muted/30">
                        <td
                          colSpan={(matrixStaffFilter === "mine" ? 1 : staffList.length) + 1}
                          className="sticky left-0 bg-muted/30 px-3 py-1.5 font-medium text-xs text-muted-foreground"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: categoryColors[category] || categoryColors[catMenus[0]?.category] || "#6B7280" }} />
                            {category}
                          </div>
                        </td>
                      </tr>
                      {catMenus.map((menu) => {
                        const assigned = matrixChanges.get(menu.id) || new Set<string>();
                        return (
                          <tr key={menu.id} className={cn("border-b hover:bg-muted/20", !menu.is_active && "opacity-50")}>
                            <td className="sticky left-0 bg-background px-3 py-2 text-xs max-w-[200px] break-words">
                              {menu.name}
                              {!menu.is_active && <span className="ml-1 text-[10px] text-muted-foreground">(非掲載)</span>}
                            </td>
                            {(matrixStaffFilter === "mine" ? staffList.filter(s => s.id === currentStaff?.id) : staffList).map((s) => (
                              <td key={s.id} className="px-2 py-2 text-center">
                                <button
                                  type="button"
                                  className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${
                                    assigned.has(s.id) ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-primary/50"
                                  }`}
                                  onClick={() => toggleMatrixCell(menu.id, s.id)}
                                >
                                  {assigned.has(s.id) && <Check className="h-3 w-3" />}
                                </button>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        {matrixHasChanges && (
          <div className="fixed bottom-16 md:bottom-0 left-0 right-0 border-t bg-background p-4 z-40">
            <Button className="w-full" onClick={handleMatrixSave} disabled={matrixSaving}>
              {matrixSaving ? "保存中..." : "変更を保存"}
            </Button>
          </div>
        )}
      </>) : viewMode === "equipment-matrix" ? (
        <Card>
          <CardHeader className="py-3 md:py-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">対応設備設定</CardTitle>
              <Button size="sm" onClick={handleEquipmentMatrixSave} disabled={equipmentMatrixSaving}>
                {equipmentMatrixSaving ? "保存中..." : "保存"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="sticky left-0 bg-muted/50 px-3 py-2 text-left font-medium min-w-[200px]">メニュー</th>
                    {equipmentList.map((eq) => (
                      <th key={eq.id} className="px-2 py-2 text-center font-medium whitespace-nowrap min-w-[60px]">
                        <div className="text-xs">{eq.name}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(allByParentCategory).map(([category, catMenus]) => (
                    <>
                      <tr key={`cat-${category}`} className="bg-muted/30">
                        <td
                          colSpan={equipmentList.length + 1}
                          className="sticky left-0 bg-muted/30 px-3 py-1.5 font-medium text-xs text-muted-foreground"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: categoryColors[category] || categoryColors[catMenus[0]?.category] || "#6B7280" }} />
                            {category}
                          </div>
                        </td>
                      </tr>
                      {catMenus.map((menu) => {
                        const assigned = equipmentMatrixChanges.get(menu.id) || new Set<string>();
                        return (
                          <tr key={menu.id} className={cn("border-b hover:bg-muted/20", !menu.is_active && "opacity-50")}>
                            <td className="sticky left-0 bg-background px-3 py-2 text-xs max-w-[200px] break-words">
                              {menu.name}
                              {!menu.is_active && <span className="ml-1 text-[10px] text-muted-foreground">(非掲載)</span>}
                            </td>
                            {equipmentList.map((eq) => (
                              <td key={eq.id} className="px-2 py-2 text-center">
                                <button
                                  type="button"
                                  className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${
                                    assigned.has(eq.id) ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30 hover:border-primary/50"
                                  }`}
                                  onClick={() => toggleEquipmentMatrixCell(menu.id, eq.id)}
                                >
                                  {assigned.has(eq.id) && <Check className="h-3 w-3" />}
                                </button>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Tabs: 通常メニュー / クーポン */}
          <div className="border-b">
            <div className="flex items-center gap-2">
              <button
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "regular" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab("regular")}
              >
                通常メニュー
                <Badge variant="secondary" className="ml-2 text-xs">{regularMenus.length}</Badge>
              </button>
              <button
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "coupon" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setActiveTab("coupon")}
              >
                クーポン
                <Badge variant="secondary" className="ml-2 text-xs">{couponMenus.length}</Badge>
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => window.location.href = `/menu-management/new?type=${activeTab === "coupon" ? "coupon" : "regular"}`}
            >
              <Plus className="mr-1 h-4 w-4" />
              {activeTab === "coupon" ? "新規クーポン" : "新規メニュー"}
            </Button>
          </div>

          {activeTab === "coupon" ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {([
                  { key: "all", label: "すべて" },
                  { key: "everyone", label: "全員" },
                  { key: "new", label: "新規" },
                  { key: "repeat", label: "再来" },
                ] as const).map(({ key, label }) => {
                  const count = key === "all"
                    ? couponMenus.length
                    : couponMenus.filter(m => key === "everyone" ? m.coupon_type === "all" : m.coupon_type === key).length;
                  return (
                    <button
                      key={key}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                        couponFilter === key
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => setCouponFilter(key)}
                    >
                      {label}
                      <span className="ml-1.5 text-xs opacity-70">{count}</span>
                    </button>
                  );
                })}
              </div>

              {(() => {
                const filtered = couponFilter === "all"
                  ? couponMenus
                  : couponMenus.filter(m => couponFilter === "everyone" ? m.coupon_type === "all" : m.coupon_type === couponFilter);
                return filtered.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      クーポンがありません
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-2 md:space-y-3">
                    {filtered.map((menu, index) => (
                      <MenuItem
                        key={menu.id}
                        menu={menu}
                        isFirst={index === 0}
                        isLast={index === filtered.length - 1}
                        onMoveUp={() => handleMove(filtered, index, "up")}
                        onMoveDown={() => handleMove(filtered, index, "down")}
                        onToggleActive={handleToggleActive}
                        onDelete={handleDelete}
                        onNavigate={(id) => window.location.href = `/menu-management/${id}?type=coupon`}
                      />
                    ))}
                  </div>
                );
              })()}
            </>
          ) : (
            regularCategoryKeys.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  メニューがありません
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4 md:space-y-6">
                {regularCategoryKeys.map((category) => {
                  const catMenus = regularByCategory[category];
                  return (
                    <Card key={category}>
                      <CardHeader className="py-3 md:py-6">
                        <div className="flex items-center gap-2">
                          <div className="w-4 h-4 rounded-full shrink-0" style={{ backgroundColor: categoryColors[category] || categoryColors[catMenus[0]?.category] || "#6B7280" }} />
                          <CardTitle className="text-base md:text-lg">{category}</CardTitle>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2 md:space-y-3">
                          {catMenus.map((menu, index) => (
                            <MenuItem
                              key={menu.id}
                              menu={menu}
                              isFirst={index === 0}
                              isLast={index === catMenus.length - 1}
                              onMoveUp={() => handleMove(catMenus, index, "up")}
                              onMoveDown={() => handleMove(catMenus, index, "down")}
                              onToggleActive={handleToggleActive}
                              onDelete={handleDelete}
                              onNavigate={(id) => window.location.href = `/menu-management/${id}`}
                            />
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
