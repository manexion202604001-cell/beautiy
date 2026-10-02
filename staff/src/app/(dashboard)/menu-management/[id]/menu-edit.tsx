"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronDown, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { menus, menuCategories, type Menu, type MenuCategory } from "@/lib/api";
import { useStore } from "@/contexts/store-context";
import { getImageUrl } from "@/lib/utils";

function getMenuIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const idx = pathParts.indexOf("menu-management");
  if (idx !== -1 && pathParts[idx + 1] && pathParts[idx + 1] !== "placeholder") {
    return pathParts[idx + 1];
  }
  return null;
}

function getQueryParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

type MenuType = "regular" | "coupon";

export default function MenuEdit({ id: propsId }: { id: string }) {
  const router = useRouter();
  const { currentStore } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [resolvedId] = useState<string>(() => getMenuIdFromUrl() || propsId);
  const isNew = resolvedId === "new";

  const [menuType, setMenuType] = useState<MenuType>(() => {
    const typeParam = getQueryParam("type");
    return typeParam === "coupon" ? "coupon" : "regular";
  });

  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<MenuCategory[]>([]);

  const [formData, setFormData] = useState({
    category: "",
    name: "",
    description: "",
    duration: 60,
    price: 0,
    coupon_type: null as "new" | "repeat" | "all" | null,
    presentation_condition: "",
    usage_condition: "",
    expiry_date: "",
    has_expiry: false,
    is_active: 1,
    price_tilde: 0,
  });

  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  useEffect(() => {
    if (!currentStore) return;
    fetchCategories();
    if (!isNew) fetchMenu();
  }, [currentStore?.id]);

  const fetchCategories = async () => {
    try {
      const { categories: data } = await menuCategories.list(currentStore?.id);
      setCategories(data);
    } catch (error) {
      console.error("Failed to fetch categories:", error);
    }
  };

  const fetchMenu = async () => {
    try {
      const { menu } = await menus.get(resolvedId);
      setMenuType(menu.menu_type === "coupon" || menu.coupon_type ? "coupon" : "regular");
      setFormData({
        category: menu.category,
        name: menu.name,
        description: menu.description || "",
        duration: menu.duration,
        price: menu.price,
        coupon_type: menu.coupon_type,
        presentation_condition: menu.presentation_condition || "",
        usage_condition: menu.usage_condition || "",
        expiry_date: menu.expiry_date || "",
        has_expiry: !!menu.expiry_date,
        is_active: menu.is_active,
        price_tilde: menu.price_tilde ?? 0,
      });
      if (menu.sub_categories) {
        try {
          const cats = JSON.parse(menu.sub_categories) as string[];
          setSelectedCategories(cats);
        } catch {
          if (menu.category) setSelectedCategories([menu.category]);
        }
      } else if (menu.category) {
        setSelectedCategories([menu.category]);
      }
      setImagePreview(getImageUrl(menu.image_url));
    } catch (error) {
      console.error("Failed to fetch menu:", error, "resolvedId:", resolvedId);
      const status = error && typeof error === "object" && "status" in error ? (error as { status: number }).status : "?";
      const msg = error instanceof Error ? error.message : String(error);
      setLoadError(`読み込み失敗 (ID: ${resolvedId}, ${status}: ${msg})`);
    } finally {
      setLoading(false);
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSubmit = async () => {
    if (!formData.name) {
      alert("名前は必須です");
      return;
    }

    try {
      setSaving(true);
      const primaryCategory = selectedCategories[0] || formData.category;
      const payload: Partial<Menu> & { store_id?: string } = {
        store_id: currentStore?.id,
        category: primaryCategory,
        name: formData.name,
        description: formData.description || null,
        duration: formData.duration,
        price: formData.price,
        menu_type: menuType,
        is_active: formData.is_active,
        coupon_type: menuType === "coupon" ? formData.coupon_type : null,
        presentation_condition: menuType === "coupon" ? (formData.presentation_condition || null) : null,
        usage_condition: menuType === "coupon" ? (formData.usage_condition || null) : null,
        expiry_date: menuType === "coupon" && formData.has_expiry ? (formData.expiry_date || null) : null,
        sub_categories: selectedCategories.length > 0 ? JSON.stringify(selectedCategories) : null,
        price_tilde: formData.price_tilde,
      };

      let menuId: string;

      if (isNew) {
        const result = await menus.create(payload);
        menuId = result.menu.id;
      } else {
        await menus.update(resolvedId, payload);
        menuId = resolvedId;
      }

      if (imageFile) {
        await menus.uploadImage(menuId, imageFile);
      }

      router.push("/menu-management");
    } catch (error) {
      console.error("Failed to save menu:", error);
      alert("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push("/menu-management")}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          メニュー一覧に戻る
        </Button>
        <Card>
          <CardContent className="py-8 text-center text-destructive">
            {loadError}
          </CardContent>
        </Card>
      </div>
    );
  }

  const renderCategorySelector = () => {
    if (categories.length === 0) {
      return (
        <Input
          value={formData.category}
          onChange={(e) => setFormData({ ...formData, category: e.target.value })}
          placeholder="カテゴリ名"
        />
      );
    }

    const parentCats = categories.filter(c => !c.parent_id);
    const childCats = categories.filter(c => c.parent_id);
    const cByParent = new Map<string, MenuCategory[]>();
    for (const child of childCats) {
      const list = cByParent.get(child.parent_id!) || [];
      list.push(child);
      cByParent.set(child.parent_id!, list);
    }

    return (
      <>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-between font-normal">
              {selectedCategories.length > 0
                ? `${selectedCategories.length}件選択中`
                : "カテゴリを選択"}
              <ChevronDown className="h-4 w-4 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
            <div className="max-h-64 overflow-y-auto p-2">
              {parentCats.map(parent => {
                const kids = cByParent.get(parent.id) || [];
                if (kids.length === 0) {
                  return (
                    <label key={parent.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer">
                      <Checkbox
                        checked={selectedCategories.includes(parent.name)}
                        onCheckedChange={() => {
                          setSelectedCategories(prev =>
                            prev.includes(parent.name)
                              ? prev.filter(c => c !== parent.name)
                              : [...prev, parent.name]
                          );
                        }}
                      />
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: parent.color }} />
                      <span className="text-sm">{parent.name}</span>
                    </label>
                  );
                }
                return (
                  <div key={parent.id}>
                    <div className="flex items-center gap-2 py-1 px-2 text-xs font-medium text-muted-foreground">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: parent.color }} />
                      {parent.name}
                    </div>
                    {kids.map(child => {
                      const dn = child.name.includes("：") ? child.name.split("：").slice(1).join("：") : child.name;
                      return (
                        <label key={child.id} className="flex items-center gap-2 py-1.5 pl-7 pr-2 rounded hover:bg-muted/50 cursor-pointer">
                          <Checkbox
                            checked={selectedCategories.includes(child.name)}
                            onCheckedChange={() => {
                              setSelectedCategories(prev =>
                                prev.includes(child.name)
                                  ? prev.filter(c => c !== child.name)
                                  : [...prev, child.name]
                              );
                            }}
                          />
                          <span className="text-sm">{dn}</span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
        {selectedCategories.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selectedCategories.map(cat => (
              <Badge key={cat} variant="secondary" className="text-xs">
                {cat.includes("：") ? cat.split("：").slice(1).join("：") : cat}
                <X className="h-3 w-3 ml-1 cursor-pointer" onClick={() =>
                  setSelectedCategories(prev => prev.filter(c => c !== cat))
                } />
              </Badge>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push("/menu-management")}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          メニュー一覧に戻る
        </Button>
      </div>

      <h1 className="text-xl font-bold">
        {isNew
          ? menuType === "coupon"
            ? "新規クーポン"
            : "新規メニュー"
          : menuType === "coupon"
            ? "クーポン編集"
            : "メニュー編集"}
      </h1>

      {menuType === "coupon" ? (
        <div className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">クーポン情報</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>種別 <span className="text-destructive">*</span></Label>
                <Select
                  value={formData.coupon_type || "all"}
                  onValueChange={(v) =>
                    setFormData({ ...formData, coupon_type: v as "new" | "repeat" | "all" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全員</SelectItem>
                    <SelectItem value="new">新規</SelectItem>
                    <SelectItem value="repeat">再来</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>クーポン名 <span className="text-destructive">*</span></Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="【ご新規様】カット+カラー"
                />
              </div>

              <div className="space-y-2">
                <Label>クーポン内容</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="クーポンの詳細説明"
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label>写真</Label>
                <div className="flex items-start gap-4">
                  {imagePreview ? (
                    <div className="relative">
                      <img
                        src={imagePreview}
                        alt="クーポン画像"
                        className="h-24 w-24 rounded-lg object-cover border"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute -top-2 -right-2 h-6 w-6 p-0 rounded-full"
                        onClick={handleRemoveImage}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-24 w-24 flex flex-col gap-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImagePlus className="h-6 w-6" />
                      <span className="text-xs">追加</span>
                    </Button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleImageChange}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">提示・利用条件</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>提示条件</Label>
                <Select
                  value={formData.presentation_condition || "none"}
                  onValueChange={(v) =>
                    setFormData({ ...formData, presentation_condition: v === "none" ? "" : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="選択してください" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">指定なし</SelectItem>
                    <SelectItem value="予約時">予約時</SelectItem>
                    <SelectItem value="来店時">来店時</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>利用条件</Label>
                <Input
                  value={formData.usage_condition}
                  onChange={(e) => setFormData({ ...formData, usage_condition: e.target.value })}
                  placeholder="営業時間外＋1100円 LED変更料＋1500円"
                />
              </div>

              <div className="space-y-2">
                <Label>有効期限</Label>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="expiry"
                      checked={!formData.has_expiry}
                      onChange={() => setFormData({ ...formData, has_expiry: false, expiry_date: "" })}
                    />
                    <span className="text-sm">設定しない</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="expiry"
                      checked={formData.has_expiry}
                      onChange={() => setFormData({ ...formData, has_expiry: true })}
                    />
                    <span className="text-sm">設定する</span>
                  </label>
                </div>
                {formData.has_expiry && (
                  <Input
                    type="date"
                    value={formData.expiry_date}
                    onChange={(e) => setFormData({ ...formData, expiry_date: e.target.value })}
                    className="w-48"
                  />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">カテゴリ・価格</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>カテゴリ</Label>
                {renderCategorySelector()}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>価格（税込） <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted-foreground">¥</span>
                    <Input
                      type="number"
                      value={formData.price}
                      onChange={(e) => setFormData({ ...formData, price: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={formData.price_tilde === 1}
                      onCheckedChange={(checked) => setFormData({ ...formData, price_tilde: checked ? 1 : 0 })}
                    />
                    <span className="text-sm">「～」を表示</span>
                  </label>
                </div>
                <div className="space-y-2">
                  <Label>所要目安時間 <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      value={formData.duration}
                      onChange={(e) => setFormData({ ...formData, duration: parseInt(e.target.value) || 0 })}
                    />
                    <span className="text-sm text-muted-foreground shrink-0">分</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">メニュー設定</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>カテゴリ</Label>
                {renderCategorySelector()}
              </div>

              <div className="space-y-2">
                <Label>メニュー名 <span className="text-destructive">*</span></Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="パリジェンヌラッシュリフト"
                />
              </div>

              <div className="space-y-2">
                <Label>メニュー説明</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="メニューの詳細説明"
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label>写真</Label>
                <div className="flex items-start gap-4">
                  {imagePreview ? (
                    <div className="relative">
                      <img
                        src={imagePreview}
                        alt="メニュー画像"
                        className="h-24 w-24 rounded-lg object-cover border"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute -top-2 -right-2 h-6 w-6 p-0 rounded-full"
                        onClick={handleRemoveImage}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-24 w-24 flex flex-col gap-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImagePlus className="h-6 w-6" />
                      <span className="text-xs">追加</span>
                    </Button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleImageChange}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>価格（税込） <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm text-muted-foreground">¥</span>
                    <Input
                      type="number"
                      value={formData.price}
                      onChange={(e) => setFormData({ ...formData, price: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={formData.price_tilde === 1}
                      onCheckedChange={(checked) => setFormData({ ...formData, price_tilde: checked ? 1 : 0 })}
                    />
                    <span className="text-sm">「～」を表示</span>
                  </label>
                </div>
                <div className="space-y-2">
                  <Label>所要目安時間 <span className="text-destructive">*</span></Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      value={formData.duration}
                      onChange={(e) => setFormData({ ...formData, duration: parseInt(e.target.value) || 0 })}
                    />
                    <span className="text-sm text-muted-foreground shrink-0">分</span>
                  </div>
                </div>
              </div>

              <div>
                <div className="space-y-2">
                  <Label>掲載</Label>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="active"
                        checked={formData.is_active === 1}
                        onChange={() => setFormData({ ...formData, is_active: 1 })}
                      />
                      <span className="text-sm">掲載</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="active"
                        checked={formData.is_active === 0}
                        onChange={() => setFormData({ ...formData, is_active: 0 })}
                      />
                      <span className="text-sm">非掲載</span>
                    </label>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex gap-2 pb-8">
        <Button variant="outline" onClick={() => router.push("/menu-management")} className="flex-1">
          キャンセル
        </Button>
        <Button onClick={handleSubmit} disabled={saving} className="flex-1">
          {saving ? "保存中..." : isNew ? "登録" : "更新"}
        </Button>
      </div>
    </div>
  );
}
