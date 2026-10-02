"use client";

import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Printer } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  staffId: string;
  staffName: string;
  storeName?: string;
};

function customerBaseUrl(): string {
  const api = process.env.NEXT_PUBLIC_API_URL || "";
  if (api.includes("localhost")) return "http://localhost:3000";
  // api.example.com -> example.com / dev-api.example.com -> dev.example.com
  return api.replace("//api.", "//").replace("-api.", ".");
}

export function WalkinQrDialog({ open, onOpenChange, storeId, staffId, staffName, storeName }: Props) {
  const url = `${customerBaseUrl()}/consent?store_id=${storeId}&staff_id=${staffId}&walkin=1`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>受付QRコード</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-4">
          {storeName && <p className="text-sm text-muted-foreground">{storeName}</p>}
          <p className="text-lg font-bold">{staffName}</p>
          <QRCodeSVG value={url} size={220} level="M" marginSize={4} />
          <p className="text-xs text-muted-foreground text-center">
            QRを読み取って同意書・カウンセリングを<br />ご記入ください
          </p>
        </div>
        <Button onClick={() => window.print()} className="w-full">
          <Printer className="mr-2 h-4 w-4" />印刷
        </Button>
      </DialogContent>

      {/* 印刷専用コンテナ（body直下に描画してダイアログのtransform影響を回避） */}
      {open && typeof document !== "undefined" && createPortal(
        <div className="walkin-print-portal">
          <style>{`
            .walkin-print-portal { display: none; }
            @media print {
              body > *:not(.walkin-print-portal) { display: none !important; }
              .walkin-print-portal { display: block !important; }
              .walkin-print-root {
                display: flex; flex-direction: column; align-items: center;
                justify-content: center; min-height: 100vh; gap: 20px; font-family: sans-serif;
              }
            }
          `}</style>
          <div className="walkin-print-root">
            {storeName && <p style={{ fontSize: 14, color: "#666", margin: 0 }}>{storeName}</p>}
            <p style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{staffName}</p>
            <QRCodeSVG value={url} size={280} level="M" marginSize={4} />
            <p style={{ fontSize: 12, color: "#666", margin: 0 }}>QRを読み取って同意書・カウンセリングをご記入ください</p>
          </div>
        </div>,
        document.body
      )}
    </Dialog>
  );
}
