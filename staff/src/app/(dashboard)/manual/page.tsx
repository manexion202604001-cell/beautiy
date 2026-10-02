"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, ChevronRight, ArrowLeft, ExternalLink } from "lucide-react";

type Manual = {
  slug: string;
  title: string;
  desc: string;
};

// マニュアルは staff/public/manuals/<slug>.html に配置（自己完結HTML）。
// 追加するときはHTMLを置いて、この配列に1行足すだけ。
const MANUALS: Manual[] = [
  {
    slug: "lime-switch",
    title: "LiME→SALOGICに切り替わるとは？",
    desc: "公式LINEのメニューがSALOGICになると、予約はどこに届き、お客様とのやり取りはどうなるか",
  },
  {
    slug: "prelink-qr",
    title: "切り替え前の作業（事前連携QR）",
    desc: "来店したお客様にQRを見せて、名前・電話の入力だけでLINEと顧客情報を事前に紐づける手順",
  },
  {
    slug: "lime-migration",
    title: "LiMEからのデータ移行",
    desc: "引き継がれる顧客情報の一覧と、引き継がれない情報（カルテ・LINE ID）の対応",
  },
  {
    slug: "karute-migration",
    title: "カルテの引き継ぎ方法",
    desc: "来店履歴のスクショから、AIで過去カルテを取り込む手順",
  },
  {
    slug: "richmenu",
    title: "リッチメニュー 初回の動き",
    desc: "4つのボタンの初回動作と、LINE IDを取得するタイミング（実画面つき）",
  },
  // 一旦非表示（2026-08-23）: 必要になったらコメントを外す。HTMLは /manuals/line-golive.html に残置
  // {
  //   slug: "line-golive",
  //   title: "導入直後のお客様連携仕様",
  //   desc: "LINE IDの扱い・お客様がつながる流れ・go-live前の注意点",
  // },
  {
    slug: "customer-merge",
    title: "顧客統合",
    desc: "重複顧客の統合手順（別店舗もOK）と、統合後のLINEメッセージが店舗ごとに動く仕組み",
  },
];

export default function ManualPage() {
  const [selected, setSelected] = useState<Manual | null>(null);

  if (selected) {
    const src = `/manuals/${selected.slug}.html`;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            一覧へ戻る
          </Button>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            新しいタブで開く
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
        <h1 className="text-lg font-bold">{selected.title}</h1>
        <iframe
          src={src}
          title={selected.title}
          className="w-full h-[calc(100dvh-11rem)] border-0 bg-transparent"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold">マニュアル</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        操作や仕様のマニュアル集です。項目を選ぶと表示されます。
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {MANUALS.map((m) => (
          <Card
            key={m.slug}
            className="cursor-pointer transition-colors hover:bg-muted/50"
            onClick={() => setSelected(m)}
          >
            <CardContent className="flex items-center gap-3 p-4">
              <div className="grid h-10 w-10 flex-none place-items-center rounded-lg bg-primary/10">
                <BookOpen className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{m.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{m.desc}</div>
              </div>
              <ChevronRight className="h-5 w-5 flex-none text-muted-foreground" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
