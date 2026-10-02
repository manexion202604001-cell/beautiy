"use client";

import { Suspense } from "react";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft } from "lucide-react";
import { customers, type Customer } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useStore } from "@/contexts/store-context";

type CustomerFormData = {
  name: string;
  name_kana: string;
  phone: string;
  email: string;
  gender: "male" | "female" | "other" | "";
  memo: string;
};

const initialFormData: CustomerFormData = {
  name: "",
  name_kana: "",
  phone: "",
  email: "",
  gender: "",
  memo: "",
};

function NewCustomerContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const isSelectMode = searchParams.get("mode") === "select";
  const { currentStore } = useStore();

  const [formData, setFormData] = useState<CustomerFormData>(initialFormData);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!formData.name.trim()) {
      alert("名前は必須です");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Partial<Customer> = {
        name: formData.name,
        name_kana: formData.name_kana || undefined,
        phone: formData.phone || undefined,
        email: formData.email || undefined,
        gender: formData.gender || undefined,
        memo: formData.memo || undefined,
        store_id: currentStore?.id,
        origin: "staff",
      };

      const { customer: created } = await customers.create(payload);
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
      console.error("Failed to save customer:", error);
      alert("顧客の登録に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold">新規顧客登録</h1>
      </div>

      <Card>
        <CardHeader className="py-4">
          <CardTitle className="text-base">顧客情報</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="form-name">
                名前 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="form-name"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                placeholder="山田 花子"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="form-name-kana">よみがな</Label>
              <Input
                id="form-name-kana"
                value={formData.name_kana}
                onChange={(e) =>
                  setFormData({ ...formData, name_kana: e.target.value })
                }
                placeholder="ヤマダ ハナコ"
              />
            </div>

            <div className="space-y-2">
              <Label>性別</Label>
              <div className="flex gap-3">
                {([
                  { value: "female", label: "女性" },
                  { value: "male", label: "男性" },
                  { value: "other", label: "その他" },
                ] as const).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "flex-1 rounded-md border px-3 py-2 text-sm transition-colors",
                      formData.gender === option.value
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "border-input hover:bg-muted/50"
                    )}
                    onClick={() =>
                      setFormData({
                        ...formData,
                        gender: formData.gender === option.value ? "" : option.value,
                      })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => router.back()}>
                キャンセル
              </Button>
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting ? "登録中..." : "登録する"}
              </Button>
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
