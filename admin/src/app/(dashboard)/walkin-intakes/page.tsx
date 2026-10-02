"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/contexts/store-context";
import { walkinIntakes, customers, type WalkinIntake, type Customer } from "@/lib/api";
import { COUNSELING_CATEGORIES } from "@/lib/counseling-questions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Search, UserPlus, Link2, Trash2, FileText } from "lucide-react";

function renderCounselingValue(v: unknown): string {
  if (Array.isArray(v)) return v.join("、");
  return String(v ?? "");
}

type ConsentSnapshot = {
  title?: string;
  version?: string;
  sections?: { title: string; items?: string[]; content?: string }[];
  agreed_at?: string;
};

export default function WalkinIntakesPage() {
  const { currentStore } = useStore();
  const [intakes, setIntakes] = useState<WalkinIntake[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<(WalkinIntake & { counseling_data: Record<string, Record<string, unknown>> | null; consent_snapshot?: ConsentSnapshot | null }) | null>(null);
  const [linkTarget, setLinkTarget] = useState<WalkinIntake | null>(null);
  const [custQuery, setCustQuery] = useState("");
  const [custResults, setCustResults] = useState<Customer[]>([]);
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    if (!currentStore) return;
    setLoading(true);
    try {
      const res = await walkinIntakes.list(currentStore.id, { q: search.trim() || undefined });
      setIntakes(res.intakes);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [currentStore, search]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const openDetail = async (it: WalkinIntake) => {
    try {
      const res = await walkinIntakes.get(it.id);
      setDetail(res.intake);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreate = async (it: WalkinIntake) => {
    if (!confirm(`「${it.customer_name}」を新規顧客として登録しますか？`)) return;
    setProcessing(true);
    try {
      await walkinIntakes.create(it.id);
      setDetail(null);
      await load();
      alert("新規顧客として登録しました");
    } catch (e) {
      console.error(e);
      alert("登録に失敗しました");
    } finally {
      setProcessing(false);
    }
  };

  const handleDiscard = async (it: WalkinIntake) => {
    if (!confirm(`「${it.customer_name}」の受付を破棄しますか？`)) return;
    setProcessing(true);
    try {
      await walkinIntakes.discard(it.id);
      setDetail(null);
      await load();
    } catch (e) {
      console.error(e);
    } finally {
      setProcessing(false);
    }
  };

  const openLink = (it: WalkinIntake) => {
    setLinkTarget(it);
    setCustQuery(it.customer_name);
    setCustResults([]);
  };

  useEffect(() => {
    if (!linkTarget || !currentStore) return;
    const t = setTimeout(async () => {
      if (!custQuery.trim()) { setCustResults([]); return; }
      try {
        const res = await customers.list({ store_id: currentStore.id, search: custQuery.trim(), limit: 20 });
        setCustResults(res.customers);
      } catch { /* noop */ }
    }, 300);
    return () => clearTimeout(t);
  }, [custQuery, linkTarget, currentStore]);

  const handleLink = async (customerId: string) => {
    if (!linkTarget) return;
    if (!confirm("この顧客に紐付けますか？カウンセリングは記入カテゴリーごとに上書きされます。")) return;
    setProcessing(true);
    try {
      await walkinIntakes.link(linkTarget.id, customerId);
      setLinkTarget(null);
      setDetail(null);
      await load();
      alert("既存顧客に紐付けました");
    } catch (e) {
      console.error(e);
      alert("紐付けに失敗しました");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="p-4 space-y-4 pb-20">
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold">同意書一覧（受付保留）</h1>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="お客様の名前・電話で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="py-8 text-center text-muted-foreground">読み込み中...</div>
      ) : intakes.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">保留中の受付はありません</div>
      ) : (
        <div className="space-y-2">
          {intakes.map((it) => (
            <Card key={it.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openDetail(it)}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{it.customer_name || "(名前なし)"}</span>
                      {it.customer_name_kana && <span className="text-xs text-muted-foreground">({it.customer_name_kana})</span>}
                      {it.has_counseling ? (
                        <Badge variant="secondary" className="text-[10px]">カウンセリング済</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-yellow-600">同意書のみ</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                      {it.customer_phone && <span>{it.customer_phone}</span>}
                      {it.staff_name && <span>担当: {it.staff_name}</span>}
                      {it.consent_submitted_at && <span>{it.consent_submitted_at}</span>}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 詳細ダイアログ */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto flex flex-col">
          <DialogHeader>
            <DialogTitle>{detail?.customer_name || "受付詳細"}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-1 text-xs">
                {detail.customer_name_kana && <div>ふりがな: {detail.customer_name_kana}</div>}
                {detail.customer_phone && <div>電話: {detail.customer_phone}</div>}
                {detail.customer_birthday && <div>生年月日: {detail.customer_birthday}</div>}
                {detail.staff_name && <div>担当: {detail.staff_name}</div>}
              </div>

              {detail.consent_snapshot && (
                <div className="space-y-2">
                  <p className="font-medium text-xs text-muted-foreground">同意書</p>
                  <div className="rounded border p-2 space-y-2">
                    {detail.consent_snapshot.title && (
                      <p className="font-medium text-sm">{detail.consent_snapshot.title}</p>
                    )}
                    {detail.consent_snapshot.sections?.map((s, i) => (
                      <div key={i}>
                        <p className="font-medium text-xs">{s.title}</p>
                        {s.items && s.items.length > 0 ? (
                          <ul className="mt-0.5 space-y-0.5 list-disc list-inside">
                            {s.items.map((item, j) => (
                              <li key={j} className="text-xs text-muted-foreground leading-relaxed">{item}</li>
                            ))}
                          </ul>
                        ) : s.content ? (
                          <p className="text-xs text-muted-foreground whitespace-pre-wrap mt-0.5">{s.content}</p>
                        ) : null}
                      </div>
                    ))}
                    {detail.consent_snapshot.agreed_at && (
                      <p className="text-[10px] text-muted-foreground border-t pt-1">
                        同意日時: {detail.consent_snapshot.agreed_at}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {detail.counseling_data && (
                <div className="space-y-2">
                  <p className="font-medium text-xs text-muted-foreground">カウンセリング内容</p>
                  {COUNSELING_CATEGORIES.filter((cat) => detail.counseling_data?.[cat.id]).map((cat) => (
                    <div key={cat.id} className="rounded border p-2">
                      <p className="font-medium text-xs mb-1">{cat.label}</p>
                      <div className="space-y-0.5">
                        {cat.questions.map((q) => {
                          const val = detail.counseling_data?.[cat.id]?.[q.id];
                          if (val == null || val === "" || (Array.isArray(val) && val.length === 0)) return null;
                          return (
                            <div key={q.id} className="text-xs flex gap-1">
                              <span className="text-muted-foreground shrink-0">{q.label}:</span>
                              <span>{renderCounselingValue(val)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button className="w-full" disabled={processing} onClick={() => detail && openLink(detail)}>
              <Link2 className="mr-2 h-4 w-4" />既存の顧客に紐付け
            </Button>
            <Button variant="outline" className="w-full" disabled={processing} onClick={() => detail && handleCreate(detail)}>
              <UserPlus className="mr-2 h-4 w-4" />新規顧客として登録
            </Button>
            <Button variant="ghost" className="w-full text-destructive" disabled={processing} onClick={() => detail && handleDiscard(detail)}>
              <Trash2 className="mr-2 h-4 w-4" />破棄
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 既存顧客紐付けダイアログ */}
      <Dialog open={!!linkTarget} onOpenChange={(o) => !o && setLinkTarget(null)}>
        <DialogContent className="max-w-md w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto flex flex-col">
          <DialogHeader>
            <DialogTitle>既存の顧客に紐付け</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="顧客名で検索" value={custQuery} onChange={(e) => setCustQuery(e.target.value)} className="pl-9" />
          </div>
          <div className="space-y-1">
            {custResults.map((c) => (
              <button
                key={c.id}
                disabled={processing}
                onClick={() => handleLink(c.id)}
                className="w-full text-left rounded-md border p-2 hover:bg-muted/50 disabled:opacity-50"
              >
                <div className="font-medium text-sm">{c.name}{c.member_no && <span className="ml-2 font-mono text-xs text-muted-foreground">{c.member_no}</span>}</div>
                <div className="text-xs text-muted-foreground">{c.name_kana} {c.phone}</div>
              </button>
            ))}
            {custQuery.trim() && custResults.length === 0 && (
              <p className="text-center text-xs text-muted-foreground py-4">該当する顧客がいません</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
