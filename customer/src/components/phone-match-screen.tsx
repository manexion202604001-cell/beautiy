"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authApi, profileApi } from "@/lib/api";

interface PhoneMatchScreenProps {
  onComplete: () => void;
}

type Mode = "choice" | "repeater" | "new";

export function PhoneMatchScreen({ onComplete }: PhoneMatchScreenProps) {
  const [mode, setMode] = useState<Mode>("choice");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    matched: boolean;
    customerName?: string;
    isNew?: boolean;
  } | null>(null);

  const handleRepeaterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const data = await authApi.phoneMatch(phone.trim());

      setResult({
        matched: data.matched,
        customerName: data.customer?.name,
      });

      setTimeout(() => onComplete(), 1500);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "エラーが発生しました";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleNewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await profileApi.update({ name: name.trim() });

      setResult({
        matched: false,
        customerName: name.trim(),
        isNew: true,
      });

      setTimeout(() => onComplete(), 1500);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "エラーが発生しました";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = () => {
    onComplete();
  };

  if (result) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <div className="text-4xl">
            {result.isNew ? "✅" : result.matched ? "🎉" : "✅"}
          </div>
          <p className="text-lg font-medium">
            {result.isNew
              ? `${result.customerName}様の登録が完了しました`
              : result.matched
                ? `${result.customerName}様のデータと連携しました`
                : "電話番号を登録しました"}
          </p>
        </div>
      </div>
    );
  }

  // Choice screen
  if (mode === "choice") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-3">
            <h1 className="text-xl font-bold">お客様情報の連携のお願い</h1>
            <p className="text-sm text-muted-foreground">
              お客様のこれまでの情報を連携させていただくため、ご協力をお願いいたします。
            </p>
          </div>

          <div className="space-y-4 text-sm">
            <div className="space-y-1">
              <p className="font-medium">▼ 以前ご利用いただいた方</p>
              <p className="text-muted-foreground">
                お名前とお電話番号をご登録いただくと、以前のカルテ情報を連携いたします。
              </p>
            </div>
            <div className="space-y-1">
              <p className="font-medium">▼ 初めてのご利用の方</p>
              <p className="text-muted-foreground">
                お名前をご登録いただくと、スムーズにご予約が行えます。
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <Button
              className="w-full"
              size="xl"
              onClick={() => setMode("repeater")}
            >
              リピーター（情報連携）
            </Button>
            <Button
              className="w-full"
              size="xl"
              variant="outline"
              onClick={() => setMode("new")}
            >
              初めての登録
            </Button>
            <div className="text-center">
              <button
                type="button"
                onClick={handleSkip}
                className="text-sm text-muted-foreground underline"
              >
                スキップ
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Repeater flow: phone input
  if (mode === "repeater") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-xl font-bold">情報連携</h1>
            <p className="text-sm text-muted-foreground">
              以前ご利用いただいた電話番号を入力すると、過去のカルテ情報と連携できます。
            </p>
          </div>

          <form onSubmit={handleRepeaterSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="phone">電話番号</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="090-1234-5678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={loading}
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              size="xl"
              disabled={loading || !phone.trim()}
            >
              {loading ? "確認中..." : "連携する"}
            </Button>
          </form>

          <div className="text-center">
            <button
              type="button"
              onClick={() => { setMode("choice"); setError(null); }}
              className="text-sm text-muted-foreground underline"
              disabled={loading}
            >
              戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  // New user flow: name input
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-xl font-bold">初めての登録</h1>
          <p className="text-sm text-muted-foreground">
            お名前をご登録いただくと、スムーズにご予約が行えます。
          </p>
        </div>

        <form onSubmit={handleNewSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">お名前</Label>
            <Input
              id="name"
              type="text"
              placeholder="山田 花子"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={loading}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <Button
            type="submit"
            className="w-full"
            size="xl"
            disabled={loading || !name.trim()}
          >
            {loading ? "登録中..." : "登録する"}
          </Button>
        </form>

        <div className="text-center">
          <button
            type="button"
            onClick={() => { setMode("choice"); setError(null); }}
            className="text-sm text-muted-foreground underline"
            disabled={loading}
          >
            戻る
          </button>
        </div>
      </div>
    </div>
  );
}
