"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { profileApi, type Customer } from "@/lib/api";
import { ChevronLeft, Check } from "lucide-react";

export default function ProfilePage() {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    name_kana: "",
    email: "",
    phone: "",
    birthday: "",
    gender: "",
  });

  useEffect(() => {
    profileApi
      .get()
      .then((data) => {
        setCustomer(data.customer);
        setFormData({
          name: data.customer.name || "",
          name_kana: data.customer.name_kana || "",
          email: data.customer.email || "",
          phone: data.customer.phone || "",
          birthday: data.customer.birthday || "",
          gender: data.customer.gender || "",
        });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);

    try {
      // email is read-only (login ID); the API does not accept it
      const { email: _email, ...updates } = formData;
      const result = await profileApi.update(updates);
      setCustomer(result.customer);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error(err);
      alert("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Link href="/mypage">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="text-xl font-bold">プロフィール設定</h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">基本情報</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">お名前 *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, name: e.target.value }))
                }
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name_kana">フリガナ</Label>
              <Input
                id="name_kana"
                value={formData.name_kana}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, name_kana: e.target.value }))
                }
                placeholder="ヤマダ タロウ"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">メールアドレス</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                readOnly
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                メールアドレスの変更は店舗までお問い合わせください
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">電話番号</Label>
              <Input
                id="phone"
                type="tel"
                value={formData.phone}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, phone: e.target.value }))
                }
                placeholder="090-1234-5678"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="birthday">生年月日</Label>
              <Input
                id="birthday"
                type="date"
                value={formData.birthday}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, birthday: e.target.value }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="gender">性別</Label>
              <Select
                value={formData.gender}
                onValueChange={(value) =>
                  setFormData((prev) => ({ ...prev, gender: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="選択してください" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">男性</SelectItem>
                  <SelectItem value="female">女性</SelectItem>
                  <SelectItem value="other">その他</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <div className="mt-4">
          <Button type="submit" className="w-full" disabled={saving}>
            {saved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                保存しました
              </>
            ) : saving ? (
              "保存中..."
            ) : (
              "保存する"
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
