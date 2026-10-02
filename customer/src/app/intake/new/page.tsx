"use client";

import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { API_BASE_URL } from "@/lib/api";
import { Loader2 } from "lucide-react";

export default function IntakeNewPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#b8936a] border-t-transparent" />
        </div>
      }
    >
      <IntakeNewPageInner />
    </Suspense>
  );
}

function IntakeNewPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = searchParams.get("session_id");
  const storeId = searchParams.get("store_id");

  const [name, setName] = useState("");
  const [nameKana, setNameKana] = useState("");
  const [gender, setGender] = useState<"female" | "male" | "other" | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sessionId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-red-500">セッションが見つかりません</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("お名前を入力してください");
      return;
    }
    if (!nameKana.trim()) {
      setError("ふりがなを入力してください");
      return;
    }
    if (!gender) {
      setError("性別を選択してください");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(
        `${API_BASE_URL}/api/public/intake/${sessionId}/profile`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            name_kana: nameKana.trim(),
            gender,
          }),
        }
      );

      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "エラーが発生しました");
        setSubmitting(false);
        return;
      }

      // Go to consent page (pass friend_url if present)
      const friendUrlParam = searchParams.get("friend_url");
      const friendParam = friendUrlParam ? `&friend_url=${encodeURIComponent(friendUrlParam)}` : "";
      router.push(`/consent?intake_session_id=${sessionId}&store_id=${storeId}${friendParam}`);
    } catch {
      setError("通信エラーが発生しました");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6 space-y-5">
          <h2 className="text-lg font-bold text-center">お客様情報</h2>

          <div className="space-y-2">
            <Label htmlFor="name">お名前</Label>
            <Input
              id="name"
              placeholder="山田 花子"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nameKana">ふりがな</Label>
            <Input
              id="nameKana"
              placeholder="やまだ はなこ"
              value={nameKana}
              onChange={(e) => setNameKana(e.target.value)}
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
                  onClick={() => setGender(option.value)}
                  className={`flex-1 rounded-lg border-2 py-3 text-sm font-medium transition-colors ${
                    gender === option.value
                      ? "border-[#b8936a] bg-[#b8936a]/10 text-[#b8936a]"
                      : "border-gray-200 text-gray-500 hover:border-gray-300"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-500 text-center">{error}</p>
          )}

          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full h-12 text-base bg-[#b8936a] hover:bg-[#a68059]"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            決定
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
