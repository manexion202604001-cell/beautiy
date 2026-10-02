"use client";

// 事前連携QR（システム切替前の店頭案内用）
// お客様がLINEでスキャン → /link で名前・カナ・電話を入力 → 既存顧客とLINE IDを紐づけ
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Printer } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  storeName?: string;
};

function customerBaseUrl(): string {
  const api = process.env.NEXT_PUBLIC_API_URL || "";
  if (api.includes("localhost")) return "http://localhost:3000";
  return api.replace("//api.", "//").replace("-api.", ".");
}

export function PrelinkQrDialog({ open, onOpenChange, storeId, storeName }: Props) {
  const url = `${customerBaseUrl()}/link?store_id=${storeId}`;

  const handlePrint = () => window.print();

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex flex-col w-[calc(100vw-2rem)] max-w-sm overflow-hidden">
          <DialogHeader>
            <DialogTitle>事前連携QRコード</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {storeName && <p className="text-sm text-muted-foreground">{storeName}</p>}
            <div className="rounded-xl border bg-white p-3">
              <QRCodeSVG value={url} size={220} level="M" marginSize={4} />
            </div>
            <p className="text-xs text-muted-foreground text-center leading-relaxed">
              システム切替のご案内用。お客様がスマホで読み取り、
              <br />
              お名前・フリガナ・電話番号を入力するとLINE連携が完了します。
              <br />
              （同意書なしの簡易版です）
            </p>
            <Button variant="outline" size="sm" onClick={handlePrint}>
              <Printer className="mr-1 h-4 w-4" />
              印刷する
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="prelink-print-portal">
            <style>{`
              .prelink-print-portal { display: none; }
              @media print {
                body > *:not(.prelink-print-portal) { display: none !important; }
                .prelink-print-portal { display: block !important; }
                .prelink-print-root {
                  display: flex; flex-direction: column; align-items: center; justify-content: center;
                  min-height: 100vh; gap: 16px; font-family: sans-serif;
                }
              }
            `}</style>
            <div className="prelink-print-root">
              <h1 style={{ fontSize: 22, margin: 0 }}>{storeName || ""}</h1>
              <p style={{ fontSize: 16, margin: 0 }}>予約システム切替のご案内</p>
              <QRCodeSVG value={url} size={300} level="M" marginSize={4} />
              <p style={{ fontSize: 13, textAlign: "center", margin: 0 }}>
                LINEでのご連絡を続けるため、読み取って
                <br />
                お名前・電話番号のご入力をお願いします
              </p>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
