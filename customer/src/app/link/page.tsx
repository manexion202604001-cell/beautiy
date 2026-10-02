"use client";

// 事前連携ページ（切替前の店頭QR用・同意書なし）
// LINEログインでユーザーIDを取得し、お名前・カナ・電話番号だけ入力してもらい、
// 既存の顧客情報と紐づける。/link?store_id=xxx で開く（LINE内・外部ブラウザ両対応）。
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import liff from "@line/liff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Loader2 } from "lucide-react";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";

export default function PreLinkPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
      <PreLinkContent />
    </Suspense>
  );
}

function PreLinkContent() {
  const searchParams = useSearchParams();

  const [storeId, setStoreId] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>("");
  const [phase, setPhase] = useState<"init" | "form" | "sending" | "done" | "error">("init");
  const [doneStatus, setDoneStatus] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [nameKana, setNameKana] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    // store_id は直接クエリ or liff.state（LINEアプリ経由）から取得
    let sid = searchParams.get("store_id");
    const liffState = searchParams.get("liff.state");
    if (!sid && liffState) {
      try {
        const decoded = decodeURIComponent(liffState);
        const qs = decoded.includes("?") ? decoded.split("?")[1] : decoded.replace(/^\/?link\??/, "");
        sid = new URLSearchParams(qs).get("store_id");
      } catch { /* ignore */ }
    }
    if (!sid) {
      // liffLogin リダイレクト後はセッションから復元
      sid = sessionStorage.getItem("prelink_store_id");
    }
    if (!sid) {
      setErrorMsg("店舗情報が指定されていません。QRコードを読み直してください。");
      setPhase("error");
      return;
    }
    sessionStorage.setItem("prelink_store_id", sid);
    setStoreId(sid);

    const setup = async (storeIdFixed: string) => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/customer/store/${storeIdFixed}`);
        const data = await res.json();
        setStoreName(data.store?.name || "");
        const liffId: string | null = data.store?.line_liff_id || null;
        if (!liffId) {
          setErrorMsg("この店舗はLINE連携の設定がありません。スタッフにお知らせください。");
          setPhase("error");
          return;
        }
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          // 外部ブラウザ（カメラでQR読取）の場合はLINEログインへ
          liff.login({ redirectUri: `${window.location.origin}/link?store_id=${storeIdFixed}` });
          return;
        }
        const token = liff.getAccessToken();
        if (!token) {
          setErrorMsg("LINEの認証情報を取得できませんでした。開き直してお試しください。");
          setPhase("error");
          return;
        }
        setAccessToken(token);
        setPhase("form");
      } catch (e) {
        console.error("prelink init failed:", e);
        setErrorMsg("読み込みに失敗しました。通信環境の良いところでお試しください。");
        setPhase("error");
      }
    };
    setup(sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async () => {
    if (!storeId || !accessToken) return;
    setPhase("sending");
    try {
      const res = await fetch(`${API_BASE_URL}/api/customer/prelink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          store_id: storeId,
          liff_access_token: accessToken,
          name: name.trim(),
          name_kana: nameKana.trim(),
          phone: phone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "送信に失敗しました");
      setDoneStatus(data.status);
      setPhase("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "送信に失敗しました");
      setPhase("form");
    }
  };

  if (phase === "init") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 bg-background p-6">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">読み込み中...</p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background p-6">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 text-center space-y-2">
            <p className="text-sm">{errorMsg}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background p-6">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <h1 className="text-lg font-bold">ありがとうございました</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {doneStatus === "already_linked"
                ? "すでに連携が完了しています。このままお使いいただけます。"
                : "ご入力を受け付けました。新しい予約システムでも、これまでどおりLINEでご予約の確認やご連絡をお受け取りいただけます。"}
            </p>
            <p className="text-xs text-muted-foreground">この画面は閉じていただいて大丈夫です。</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background p-4 flex items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6 space-y-5">
          <div className="text-center space-y-1">
            <h1 className="text-lg font-bold">会員情報のご確認</h1>
            {storeName && <p className="text-sm text-muted-foreground">{storeName}</p>}
            <p className="text-xs text-muted-foreground leading-relaxed pt-1">
              予約システムの切り替えにともない、LINEでのご連絡を続けるためにお名前と電話番号のご入力をお願いします。
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">お名前 <span className="text-destructive">*</span></Label>
              <Input
                id="name"
                placeholder="山田 花子"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 max-w-full appearance-none py-0 items-center text-base"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kana">フリガナ <span className="text-destructive">*</span></Label>
              <Input
                id="kana"
                placeholder="ヤマダ ハナコ"
                value={nameKana}
                onChange={(e) => setNameKana(e.target.value)}
                className="min-w-0 max-w-full appearance-none py-0 items-center text-base"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">電話番号 <span className="text-destructive">*</span></Label>
              <Input
                id="phone"
                type="tel"
                placeholder="090-1234-5678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="min-w-0 max-w-full appearance-none py-0 items-center text-base"
              />
            </div>
          </div>

          {errorMsg && (
            <p className="text-sm text-destructive">{errorMsg}</p>
          )}

          <Button
            className="w-full"
            size="lg"
            disabled={!name.trim() || !nameKana.trim() || !phone.trim() || phase === "sending"}
            onClick={handleSubmit}
          >
            {phase === "sending" ? "送信中..." : "送信する"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
