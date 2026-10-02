"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, Clock } from "lucide-react";
import { staffMenus, type StaffMenu } from "@/lib/api";

const formatDuration = (minutes: number) => {
  if (minutes < 60) return `${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}時間${m}分` : `${h}時間`;
};

const formatPrice = (price: number) =>
  `¥${price.toLocaleString()}`;

export default function MyMenusPage() {
  const [menus, setMenus] = useState<StaffMenu[]>([]);
  const [loading, setLoading] = useState(true);
  const [editMenu, setEditMenu] = useState<StaffMenu | null>(null);
  const [isCreateMode, setIsCreateMode] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StaffMenu | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formDuration, setFormDuration] = useState("60");
  const [formPrice, setFormPrice] = useState("0");

  const fetchMenus = useCallback(async () => {
    try {
      const data = await staffMenus.list();
      setMenus(data.menus);
    } catch (error) {
      console.error("Failed to fetch menus:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMenus();
  }, [fetchMenus]);

  const openCreateDialog = () => {
    setFormName("");
    setFormCategory("");
    setFormDuration("60");
    setFormPrice("0");
    setIsCreateMode(true);
    setEditMenu({} as StaffMenu); // Trigger dialog open
  };

  const openEditDialog = (menu: StaffMenu) => {
    setFormName(menu.name);
    setFormCategory(menu.category);
    setFormDuration(String(menu.duration));
    setFormPrice(String(menu.price));
    setIsCreateMode(false);
    setEditMenu(menu);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formDuration || !formPrice) return;
    setSaving(true);
    try {
      if (isCreateMode) {
        await staffMenus.create({
          name: formName.trim(),
          category: formCategory.trim(),
          duration: parseInt(formDuration),
          price: parseInt(formPrice),
        });
      } else if (editMenu?.id) {
        await staffMenus.update(editMenu.id, {
          name: formName.trim(),
          category: formCategory.trim(),
          duration: parseInt(formDuration),
          price: parseInt(formPrice),
        });
      }
      setEditMenu(null);
      fetchMenus();
    } catch (error) {
      console.error("Failed to save:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await staffMenus.delete(deleteTarget.id);
      setDeleteTarget(null);
      fetchMenus();
    } catch (error) {
      console.error("Failed to delete:", error);
    }
  };

  const handleReorder = async (menuId: string, direction: "up" | "down") => {
    const idx = menus.findIndex((m) => m.id === menuId);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= menus.length) return;

    // Only swap within same category
    if (menus[idx].category !== menus[swapIdx].category) return;

    const updated = [...menus];
    [updated[idx], updated[swapIdx]] = [updated[swapIdx], updated[idx]];
    setMenus(updated);

    try {
      await staffMenus.reorder([
        { id: updated[idx].id, sort_order: idx },
        { id: updated[swapIdx].id, sort_order: swapIdx },
      ]);
    } catch (error) {
      console.error("Failed to reorder:", error);
      fetchMenus();
    }
  };

  // Group menus by category
  const grouped = menus.reduce<Record<string, StaffMenu[]>>((acc, menu) => {
    const cat = menu.category || "未分類";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(menu);
    return acc;
  }, {});

  // Get unique categories for suggestions
  const categories = [...new Set(menus.map((m) => m.category).filter(Boolean))];

  if (loading) {
    return (
      <div className="p-4">
        <div className="py-12 text-center text-muted-foreground">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">マイメニュー</h1>
        <Button onClick={openCreateDialog} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          追加
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        予約作成時に使える個人メニューです。他のスタッフやお客様には表示されません。
      </p>

      {menus.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <p>マイメニューがありません</p>
          <Button onClick={openCreateDialog} variant="outline" className="mt-4">
            <Plus className="h-4 w-4 mr-1" />
            最初のメニューを追加
          </Button>
        </div>
      ) : (
        Object.entries(grouped).map(([category, categoryMenus]) => (
          <Card key={category}>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {category}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0 space-y-2">
              {categoryMenus.map((menu, idx) => (
                <div
                  key={menu.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{menu.name}</div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDuration(menu.duration)}
                      </span>
                      <span className="font-medium text-foreground">
                        {formatPrice(menu.price)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleReorder(menu.id, "up")}
                      disabled={idx === 0}
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleReorder(menu.id, "down")}
                      disabled={idx === categoryMenus.length - 1}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEditDialog(menu)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => setDeleteTarget(menu)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={!!editMenu} onOpenChange={(open) => !open && setEditMenu(null)}>
        <DialogContent className="w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{isCreateMode ? "メニュー追加" : "メニュー編集"}</DialogTitle>
          </DialogHeader>
          <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="menuName">メニュー名</Label>
              <Input
                id="menuName"
                name="menu-name-x"
                type="search"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="カット + カラー"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="menuCategory">カテゴリ</Label>
              <Input
                id="menuCategory"
                name="menu-cat-x"
                type="search"
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value)}
                placeholder="カット / カラー / パーマ 等"
                list="category-suggestions"
                autoComplete="off"
              />
              {categories.length > 0 && (
                <datalist id="category-suggestions">
                  {categories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="menuDuration">施術時間（分）</Label>
                <Input
                  id="menuDuration"
                  type="number"
                  value={formDuration}
                  onChange={(e) => setFormDuration(e.target.value)}
                  min="5"
                  step="5"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="menuPrice">料金（円）</Label>
                <Input
                  id="menuPrice"
                  type="number"
                  value={formPrice}
                  onChange={(e) => setFormPrice(e.target.value)}
                  min="0"
                  step="100"
                />
              </div>
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditMenu(null)}>
              キャンセル
            </Button>
            <Button onClick={handleSave} disabled={saving || !formName.trim()}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>メニューを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」を削除します。この操作は取り消せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>削除する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
