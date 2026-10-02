"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { auth } from "@/lib/api";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("パスワードは8文字以上にしてください");
      return;
    }
    if (password !== confirmPassword) {
      setError("パスワードが一致しません");
      return;
    }

    setLoading(true);
    try {
      await auth.resetPassword(token, password);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-destructive">無効なリンクです。</p>
        <Link href="/forgot-password">
          <Button variant="outline" className="w-full">パスワードリセットを再申請</Button>
        </Link>
      </div>
    );
  }

  if (success) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-muted-foreground">
          パスワードを変更しました。新しいパスワードでログインしてください。
        </p>
        <Link href="/login">
          <Button className="w-full">ログインへ</Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="password">新しいパスワード</Label>
        <Input
          id="password"
          type="password"
          placeholder="8文字以上"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">パスワード（確認）</Label>
        <Input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={8}
        />
      </div>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "変更中..." : "パスワードを変更"}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#1a1a1a' }}>SALO</span>
            <span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 700, color: '#b8936a' }}>GIC</span>
            <span style={{ fontFamily: 'var(--font-montserrat)', fontWeight: 200, color: '#b8936a' }}> Staff</span>
          </CardTitle>
          <CardDescription>新しいパスワードの設定</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<div className="text-center text-sm text-muted-foreground">読み込み中...</div>}>
            <ResetPasswordForm />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
