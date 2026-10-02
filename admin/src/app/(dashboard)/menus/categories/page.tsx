"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Plus, Edit, Trash2, Upload, Copy, X, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { menuCategories, type MenuCategory } from "@/lib/api";
import { useStore } from "@/contexts/store-context";

const PRESET_COLORS = [
  { name: "グレー", value: "#6B7280" },
  { name: "レッド", value: "#EF4444" },
  { name: "オレンジ", value: "#F97316" },
  { name: "イエロー", value: "#EAB308" },
  { name: "グリーン", value: "#22C55E" },
  { name: "ティール", value: "#14B8A6" },
  { name: "ブルー", value: "#3B82F6" },
  { name: "インディゴ", value: "#6366F1" },
  { name: "パープル", value: "#A855F7" },
  { name: "ピンク", value: "#EC4899" },
];

// Helper: extract display name from full-path category name
function displayName(cat: MenuCategory, parents: MenuCategory[]): string {
  if (!cat.parent_id) return cat.name;
  const parent = parents.find((p) => p.id === cat.parent_id);
  if (!parent) return cat.name;
  // Strip "parent ： " or "parent：" prefix
  const prefixes = [`${parent.name} ： `, `${parent.name}：`];
  for (const prefix of prefixes) {
    if (cat.name.startsWith(prefix)) return cat.name.slice(prefix.length);
  }
  return cat.name;
}

const SB_CATEGORY_SCRIPT = `(()=>{const r=[];const t=document.querySelector('#TagIN_COUPON_CATEGORY table');if(!t){alert('カテゴリテーブルが見つかりません');return}t.querySelectorAll('tr').forEach(tr=>{const th=tr.querySelector('th');const td=tr.querySelector('td');if(!th||!td)return;const p=th.textContent.trim();const ch=[];td.querySelectorAll('li').forEach(li=>{const s=li.textContent.trim();if(s)ch.push(s)});if(p)r.push({parent:p,children:ch})});const j=JSON.stringify(r);const ta=document.createElement('textarea');ta.value=j;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);alert('コピーしました（'+r.length+'グループ）')})()`;

export default function CategoriesPage() {
  const router = useRouter();
  const { currentStore } = useStore();

  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"parent" | "child">("parent");
  const [editingCategory, setEditingCategory] = useState<MenuCategory | null>(null);
  const [formName, setFormName] = useState("");
  const [formColor, setFormColor] = useState("#6B7280");
  const [formParentId, setFormParentId] = useState<string>("");

  // SB import
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importJsonText, setImportJsonText] = useState("");
  const [importing, setImporting] = useState(false);

  // Expanded parents
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (currentStore) fetchCategories();
  }, [currentStore?.id]);

  const fetchCategories = async () => {
    try {
      const { categories: data } = await menuCategories.list(currentStore?.id);
      setCategories(data);
      // Auto-expand all parents
      const parentIds = new Set(data.filter((c) => !c.parent_id).map((c) => c.id));
      setExpandedParents(parentIds);
    } catch (error) {
      console.error("Failed to fetch categories:", error);
    } finally {
      setLoading(false);
    }
  };

  const parents = categories.filter((c) => !c.parent_id);
  const childrenOf = (parentId: string) =>
    categories.filter((c) => c.parent_id === parentId);

  const toggleExpand = (parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  };

  // Open dialog for new parent
  const openNewParent = () => {
    setDialogMode("parent");
    setEditingCategory(null);
    setFormName("");
    setFormColor(PRESET_COLORS[parents.length % PRESET_COLORS.length].value);
    setFormParentId("");
    setDialogOpen(true);
  };

  // Open dialog for new child
  const openNewChild = (parentId: string) => {
    setDialogMode("child");
    setEditingCategory(null);
    setFormName("");
    setFormColor("");
    setFormParentId(parentId);
    setDialogOpen(true);
  };

  // Open dialog for editing
  const openEdit = (cat: MenuCategory) => {
    if (cat.parent_id) {
      setDialogMode("child");
      setFormParentId(cat.parent_id);
      setFormName(displayName(cat, parents));
      setFormColor("");
    } else {
      setDialogMode("parent");
      setFormParentId("");
      setFormName(cat.name);
      setFormColor(cat.color);
    }
    setEditingCategory(cat);
    setDialogOpen(true);
  };

  // Build the full child name: "parent：child"
  const buildChildName = (parentName: string, childDisplayName: string) => {
    return `${parentName}：${childDisplayName}`;
  };

  const handleSave = async () => {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      if (dialogMode === "parent") {
        if (editingCategory) {
          // If parent name changed, update all children names too
          const oldName = editingCategory.name;
          await menuCategories.update(editingCategory.id, {
            name: formName.trim(),
            color: formColor,
          });
          // Update children's full-path names if parent name changed
          if (oldName !== formName.trim()) {
            const children = childrenOf(editingCategory.id);
            for (const child of children) {
              const childDisplay = displayName(child, parents);
              const newChildName = buildChildName(formName.trim(), childDisplay);
              await menuCategories.update(child.id, { name: newChildName });
            }
          }
        } else {
          await menuCategories.create({
            store_id: currentStore?.id,
            name: formName.trim(),
            color: formColor,
            parent_id: null,
          });
        }
      } else {
        // Child
        const parent = parents.find((p) => p.id === formParentId);
        if (!parent) return;
        const fullName = buildChildName(parent.name, formName.trim());
        if (editingCategory) {
          await menuCategories.update(editingCategory.id, {
            name: fullName,
            parent_id: formParentId,
          });
        } else {
          await menuCategories.create({
            store_id: currentStore?.id,
            name: fullName,
            color: parent.color,
            parent_id: formParentId,
          });
        }
      }
      await fetchCategories();
      setDialogOpen(false);
    } catch (error) {
      console.error("Failed to save category:", error);
      alert("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (cat: MenuCategory) => {
    const label = cat.parent_id ? displayName(cat, parents) : cat.name;
    const children = cat.parent_id ? [] : childrenOf(cat.id);
    const msg = children.length > 0
      ? `「${label}」と配下の${children.length}件の子カテゴリを削除しますか？`
      : `「${label}」を削除しますか？`;
    if (!confirm(msg)) return;
    try {
      await menuCategories.delete(cat.id);
      await fetchCategories();
    } catch (error) {
      console.error("Failed to delete:", error);
      alert("削除に失敗しました。メニューで使用されている可能性があります。");
    }
  };

  const handleDeleteAll = async () => {
    if (!currentStore) return;
    if (!confirm("すべてのカテゴリを削除しますか？")) return;
    try {
      await menuCategories.deleteAll(currentStore.id);
      await fetchCategories();
    } catch (error) {
      console.error("Failed to delete all:", error);
    }
  };

  // SB import: handle [{parent, children}] format from checkbox table
  const handleSbImport = async () => {
    if (!importJsonText.trim() || !currentStore) return;
    setImporting(true);
    try {
      const data = JSON.parse(importJsonText) as { parent: string; children: string[] }[];
      if (!Array.isArray(data) || data.length === 0) {
        alert("データが空です");
        setImporting(false);
        return;
      }

      // Fetch current categories to skip duplicates
      const { categories: existing } = await menuCategories.list(currentStore.id);
      const existingNames = new Set(existing.map((c) => c.name));

      let createdParents = 0;
      let createdChildren = 0;
      let skipped = 0;
      let colorIdx = existing.filter((c) => !c.parent_id).length;

      for (const group of data) {
        const parentName = group.parent?.trim();
        if (!parentName) continue;

        // Create or find parent
        let parentId: string | undefined;
        const existingParent = existing.find(
          (c) => c.name === parentName && !c.parent_id
        );
        if (existingParent) {
          parentId = existingParent.id;
        } else if (!existingNames.has(parentName)) {
          try {
            const result = await menuCategories.create({
              store_id: currentStore.id,
              name: parentName,
              color: PRESET_COLORS[colorIdx % PRESET_COLORS.length].value,
              parent_id: null,
            });
            parentId = result.category.id;
            existingNames.add(parentName);
            colorIdx++;
            createdParents++;
          } catch {
            skipped++;
            continue;
          }
        } else {
          skipped++;
          continue;
        }

        // Create children
        for (const childDisplay of group.children || []) {
          const trimmed = childDisplay.trim();
          if (!trimmed) continue;
          const fullName = `${parentName}：${trimmed}`;
          if (existingNames.has(fullName)) {
            skipped++;
            continue;
          }
          try {
            await menuCategories.create({
              store_id: currentStore.id,
              name: fullName,
              parent_id: parentId,
            });
            existingNames.add(fullName);
            createdChildren++;
          } catch {
            skipped++;
          }
        }
      }

      await fetchCategories();
      setImportDialogOpen(false);
      setImportJsonText("");
      alert(
        `親カテゴリ ${createdParents}件、子カテゴリ ${createdChildren}件を作成しました。${skipped > 0 ? `（${skipped}件スキップ）` : ""}`
      );
    } catch {
      alert("JSONの形式が正しくありません");
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/menus/")}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          メニュー一覧に戻る
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportDialogOpen(true)}
          >
            <Upload className="h-4 w-4 mr-1" />
            SBから取込
          </Button>
          {categories.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleDeleteAll}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              全削除
            </Button>
          )}
        </div>
      </div>

      <h1 className="text-xl font-bold">カテゴリ管理</h1>

      {/* Category tree */}
      <Card>
        <CardContent className="p-4 space-y-1">
          {parents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              カテゴリがありません。「SBから取込」またはボタンから追加してください。
            </p>
          ) : (
            parents.map((parent) => {
              const children = childrenOf(parent.id);
              const isExpanded = expandedParents.has(parent.id);
              return (
                <div key={parent.id}>
                  {/* Parent row */}
                  <div className="flex items-center gap-2 py-2 px-2 rounded-md hover:bg-muted/50 group">
                    <button
                      onClick={() => toggleExpand(parent.id)}
                      className="p-0.5"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                    <div
                      className="w-4 h-4 rounded-full shrink-0"
                      style={{ backgroundColor: parent.color }}
                    />
                    <span className="font-medium text-sm flex-1">
                      {parent.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {children.length}件
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100"
                      onClick={() => openNewChild(parent.id)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100"
                      onClick={() => openEdit(parent)}
                    >
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 text-destructive"
                      onClick={() => handleDelete(parent)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {/* Children */}
                  {isExpanded && children.length > 0 && (
                    <div className="ml-7 border-l-2 pl-3" style={{ borderColor: parent.color + "40" }}>
                      {children.map((child) => (
                        <div
                          key={child.id}
                          className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 group"
                        >
                          <span className="text-sm flex-1">
                            {displayName(child, parents)}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                            onClick={() => openEdit(child)}
                          >
                            <Edit className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-destructive"
                            onClick={() => handleDelete(child)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Add parent button */}
      <Button variant="outline" onClick={openNewParent} className="w-full">
        <Plus className="h-4 w-4 mr-1" />
        親カテゴリを追加
      </Button>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {editingCategory
                ? dialogMode === "parent"
                  ? "親カテゴリ編集"
                  : "子カテゴリ編集"
                : dialogMode === "parent"
                  ? "親カテゴリ追加"
                  : "子カテゴリ追加"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {dialogMode === "child" && (
              <div className="space-y-2">
                <Label>親カテゴリ</Label>
                <Select
                  value={formParentId}
                  onValueChange={setFormParentId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="親カテゴリを選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {parents.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: p.color }}
                          />
                          {p.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>
                {dialogMode === "parent" ? "カテゴリ名" : "子カテゴリ名"}
              </Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={
                  dialogMode === "parent" ? "ネイル" : "ジェル"
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                }}
              />
            </div>
            {dialogMode === "parent" && (
              <div className="space-y-2">
                <Label>色</Label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color.value}
                      type="button"
                      className={`w-8 h-8 rounded-full border-2 transition-all ${
                        formColor === color.value
                          ? "border-foreground scale-110"
                          : "border-transparent hover:scale-105"
                      }`}
                      style={{ backgroundColor: color.value }}
                      onClick={() => setFormColor(color.value)}
                      title={color.name}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={handleSave} disabled={saving || !formName.trim()}>
              {saving ? "保存中..." : editingCategory ? "更新" : "追加"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* SB Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>サロンボードからカテゴリ取込</DialogTitle>
            <DialogDescription>
              SBのクーポン編集画面の「検索カテゴリ」を開いた状態でスクリプトを実行し、コピーされたJSONを貼り付けてください。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">
                1. SBのコンソールで実行
              </Label>
              <pre className="bg-muted rounded-md p-2 mt-1 text-[10px] font-mono max-h-16 overflow-hidden whitespace-pre-wrap break-all text-muted-foreground">
                {SB_CATEGORY_SCRIPT}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-1.5 w-full"
                onClick={() => navigator.clipboard.writeText(SB_CATEGORY_SCRIPT)}
              >
                <Copy className="h-3 w-3 mr-1.5" />
                スクリプトをコピー
              </Button>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                2. コピーされたJSONを貼り付け
              </Label>
              <Textarea
                className="mt-1 font-mono text-xs"
                placeholder='[{"parent":"ネイル","children":["ジェル","スカルプ",...]},...]'
                value={importJsonText}
                onChange={(e) => setImportJsonText(e.target.value)}
                rows={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setImportDialogOpen(false)}
            >
              キャンセル
            </Button>
            <Button
              onClick={handleSbImport}
              disabled={importing || !importJsonText.trim()}
            >
              {importing ? "取込中..." : "取り込み"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
