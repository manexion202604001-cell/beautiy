"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { authApi, setStoreId } from "@/lib/api";

export default function LineCallbackPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <LineCallbackInner />
    </Suspense>
  );
}

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}

function decodeState(state: string): { store_id?: string; nonce?: string } | null {
  try {
    return JSON.parse(atob(state));
  } catch {
    return null;
  }
}

function LineCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const lineError = searchParams.get("error");

    const expectedNonce = sessionStorage.getItem("line_login_nonce");
    const redirectTo = sessionStorage.getItem("line_login_redirect") || "/";
    sessionStorage.removeItem("line_login_nonce");
    sessionStorage.removeItem("line_login_redirect");

    if (lineError) {
      setError("LINEログインがキャンセルされました");
      return;
    }
    if (!code || !state) {
      setError("ログイン情報が見つかりません");
      return;
    }

    const stateData = decodeState(state);
    // Reject callbacks that were not started from this browser (login CSRF)
    if (!stateData || !expectedNonce || stateData.nonce !== expectedNonce) {
      setError("ログインの有効期限が切れました。もう一度お試しください");
      return;
    }
    if (stateData.store_id) {
      setStoreId(stateData.store_id);
    }

    authApi
      .lineCallback(code, state)
      .then(() => {
        // Keep store context across the full-page redirect (store override is in-memory only)
        const target = new URL(redirectTo, window.location.origin);
        if (stateData.store_id && !target.searchParams.has("store_id")) {
          target.searchParams.set("store_id", stateData.store_id);
        }
        router.replace(target.pathname + target.search);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "LINEログインに失敗しました");
      });
  }, [router, searchParams]);

  if (!error) return <Spinner />;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4 pt-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <Button asChild className="w-full">
            <Link href="/login">ログイン画面に戻る</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
