"use client";

import { Suspense } from "react";
import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft } from "lucide-react";
import { customers, staff as staffApi, type Staff } from "@/lib/api";
import { useStore } from "@/contexts/store-context";

type CustomerFormData = {
  name: string;
  name_kana: string;
  gender: "male" | "female" | "other" | "";
  birthday: string;
  occupation: string;
  postal_code: string;
  address: string;
  phone: string;
  email: string;
  memo: string;
  staff_id: string;
};

const initialFormData: CustomerFormData = {
  name: "", name_kana: "", gender: "", birthday: "", occupation: "",
  postal_code: "", address: "", phone: "", email: "", memo: "", staff_id: "",
};

function NewCustomerContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const isSelectMode = searchParams.get("mode") === "select";
  const { currentStore } = useStore();

  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [formData, setFormData] = useState<CustomerFormData>(initialFormData);
  const [submitting, setSubmitting] = useState(false);
  const [searchingAddress, setSearchingAddress] = useState(false);

  useEffect(() => {
    if (!currentStore) return;
    staffApi.list().then(({ staff }) => setStaffList(staff)).catch(console.error);
  }, [currentStore?.id]);

  const searchAddressByPostalCode = async (postalCode: string) => {
    const cleanedCode = postalCode.replace(/-/g, "");
    if (cleanedCode.length !== 7 || !/^\d+$/.test(cleanedCode)) return;
    setSearchingAddress(true);
    try {
      const response = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${cleanedCode}`);
      const data = await response.json();
      if (data.results?.length > 0) {
        const result = data.results[0];
        setFormData((prev) => ({ ...prev, address: `${result.address1}${result.address2}${result.address3}` }));
      }
    } catch (error) {
      console.error("Failed to search address:", error);
    } finally {
      setSearchingAddress(false);
    }
  };

  const handleCreateCustomer = async () => {
    if (!formData.name.trim()) { alert("名前は必須です"); return; }
    setSubmitting(true);
    try {
      const { customer: created } = await customers.create({
        name: formData.name,
        name_kana: formData.name_kana || undefined,
        gender: formData.gender || undefined,
        birthday: formData.birthday || undefined,
        occupation: formData.occupation || undefined,
        postal_code: formData.postal_code || undefined,
        address: formData.address || undefined,
        phone: formData.phone || undefined,
        email: formData.email || undefined,
        memo: formData.memo || undefined,
        staff_id: formData.staff_id && formData.staff_id !== "none" ? formData.staff_id : undefined,
      });
      if (isSelectMode && created) {
        router.push(`/reservations/new?customer_id=${created.id}&customer_name=${encodeURIComponent(created.name)}`);
        return;
      }
      if (created) {
        router.push(`/customers?id=${created.id}`);
      } else {
        router.push("/customers");
      }
    } catch (error) {
      console.error("Failed to create customer:", error);
      alert("顧客の登録に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl md:text-2xl font-bold">新規顧客登録</h1>
      </div>

      <Card>
        <CardHeader className="py-4 md:py-6">
          <CardTitle className="text-base md:text-lg">顧客情報</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>名前 <span className="text-destructive">*</span></Label>
                <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="山田 花子" />
              </div>
              <div className="space-y-2">
                <Label>よみがな</Label>
                <Input value={formData.name_kana} onChange={(e) => setFormData({ ...formData, name_kana: e.target.value })} placeholder="ヤマダ ハナコ" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>性別</Label>
                <Select value={formData.gender} onValueChange={(v) => setFormData({ ...formData, gender: v as CustomerFormData["gender"] })}>
                  <SelectTrigger><SelectValue placeholder="選択してください" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="female">女性</SelectItem>
                    <SelectItem value="male">男性</SelectItem>
                    <SelectItem value="other">その他</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>生年月日</Label>
                <Input type="date" value={formData.birthday} onChange={(e) => setFormData({ ...formData, birthday: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>職業</Label>
              <Input value={formData.occupation} onChange={(e) => setFormData({ ...formData, occupation: e.target.value })} placeholder="会社員" />
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>電話番号</Label>
                <Input type="tel" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} placeholder="090-1234-5678" />
              </div>
              <div className="space-y-2">
                <Label>メールアドレス</Label>
                <Input type="email" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} placeholder="example@email.com" />
              </div>
            </div>
            <Separator />
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>郵便番号</Label>
                <div className="relative">
                  <Input
                    value={formData.postal_code}
                    onChange={(e) => {
                      const value = e.target.value;
                      setFormData({ ...formData, postal_code: value });
                      if (value.replace(/-/g, "").length === 7) searchAddressByPostalCode(value);
                    }}
                    placeholder="123-4567"
                  />
                  {searchingAddress && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    </div>
                  )}
                </div>
              </div>
              <div className="col-span-2 space-y-2">
                <Label>住所</Label>
                <Input value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} placeholder="東京都渋谷区..." />
              </div>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>担当スタッフ</Label>
              <Select value={formData.staff_id} onValueChange={(v) => setFormData({ ...formData, staff_id: v })}>
                <SelectTrigger><SelectValue placeholder="担当未設定" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">担当未設定</SelectItem>
                  {staffList.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>メモ</Label>
              <Textarea value={formData.memo} onChange={(e) => setFormData({ ...formData, memo: e.target.value })} placeholder="特記事項など" rows={3} />
            </div>
            <Separator />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => router.back()}>キャンセル</Button>
              <Button onClick={handleCreateCustomer} disabled={submitting}>{submitting ? "登録中..." : "登録する"}</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function NewCustomerPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-muted-foreground">読み込み中...</div>}>
      <NewCustomerContent />
    </Suspense>
  );
}
