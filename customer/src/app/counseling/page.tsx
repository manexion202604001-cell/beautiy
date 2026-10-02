"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Save, Check, Loader2 } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import {
  COUNSELING_CATEGORIES,
  type CounselingCategory,
  type CounselingQuestion,
  type CounselingData,
} from "@/lib/counseling-questions";
import { API_BASE_URL } from "@/lib/api";

type SaveStatus = "idle" | "saving" | "saved";

function CounselingContent() {
  const searchParams = useSearchParams();
  const reservationId = searchParams.get("reservation_id");
  const storeId = searchParams.get("store_id");
  const intakeSessionId = searchParams.get("intake_session_id");
  const token = searchParams.get("token");
  const walkinId = searchParams.get("walkin_id");

  const [data, setData] = useState<CounselingData>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [isLiff, setIsLiff] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const liff = (await import("@line/liff")).default;
        if (liff.isInClient()) setIsLiff(true);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!reservationId && !storeId && !intakeSessionId && !walkinId) {
      setError("予約情報が見つかりません");
      setLoading(false);
      return;
    }

    // Pre-fill from consent form (name, birthday, phone)
    const prefillName = searchParams.get("prefill_name");
    const prefillBirthday = searchParams.get("prefill_birthday");
    const prefillPhone = searchParams.get("prefill_phone");

    if (walkinId) {
      // 受付QR（純Web）フロー: 保留レコードのカウンセリングを取得（再開用）
      fetch(`${API_BASE_URL}/api/public/counseling/walkin/${walkinId}`)
        .then((res) => res.json())
        .then((res) => {
          const existing = res.counseling_sheet?.data || {};
          const basicInfo = existing.basic_info || {};
          if (prefillBirthday && !basicInfo.birthday) basicInfo.birthday = prefillBirthday;
          if (prefillPhone && !basicInfo.phone) basicInfo.phone = prefillPhone;
          existing.basic_info = basicInfo;
          setData(existing);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    } else if (intakeSessionId) {
      // Load pre-filled data from intake session (for returning customers)
      fetch(`${API_BASE_URL}/api/public/intake/${intakeSessionId}/counseling`)
        .then((res) => res.json())
        .then((res) => {
          const existing = res.data || {};
          // Merge prefill data from consent form into basic_info
          if (prefillName || prefillBirthday || prefillPhone) {
            const basicInfo = existing.basic_info || {};
            if (prefillBirthday && !basicInfo.birthday) basicInfo.birthday = prefillBirthday;
            if (prefillPhone && !basicInfo.phone) basicInfo.phone = prefillPhone;
            existing.basic_info = basicInfo;
          }
          setData(existing);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
      // Update intake status
      fetch(`${API_BASE_URL}/api/public/intake/${intakeSessionId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "counseling" }),
      }).catch(() => {});
    } else if (reservationId) {
      fetch(`${API_BASE_URL}/api/public/counseling/${reservationId}${token ? `?token=${token}` : ''}`)
        .then((res) => res.json())
        .then((res) => {
          if (res.error) {
            setError("予約情報が見つかりません");
          } else if (res.counseling_sheet) {
            const existing = res.counseling_sheet.data || {};
            const basicInfo = existing.basic_info || {};
            if (prefillBirthday && !basicInfo.birthday) basicInfo.birthday = prefillBirthday;
            if (prefillPhone && !basicInfo.phone) basicInfo.phone = prefillPhone;
            existing.basic_info = basicInfo;
            setData(existing);
          } else if (prefillBirthday || prefillPhone) {
            setData({ basic_info: { ...(prefillBirthday ? { birthday: prefillBirthday } : {}), ...(prefillPhone ? { phone: prefillPhone } : {}) } });
          }
        })
        .catch(() => setError("読み込みに失敗しました"))
        .finally(() => setLoading(false));
    } else {
      // store_id only mode — new counseling sheet without reservation
      if (prefillBirthday || prefillPhone) {
        setData({ basic_info: { ...(prefillBirthday ? { birthday: prefillBirthday } : {}), ...(prefillPhone ? { phone: prefillPhone } : {}) } });
      }
      setLoading(false);
    }
  }, [reservationId, storeId, intakeSessionId, walkinId]);

  const handleSave = useCallback(async () => {
    if (!reservationId && !storeId && !intakeSessionId && !walkinId) return;
    setSaveStatus("saving");
    try {
      const tokenParam = token ? `?token=${token}` : '';
      const url = walkinId
        ? `${API_BASE_URL}/api/public/counseling/walkin/${walkinId}`
        : intakeSessionId
        ? `${API_BASE_URL}/api/public/intake/${intakeSessionId}/counseling`
        : reservationId
          ? `${API_BASE_URL}/api/public/counseling/${reservationId}${tokenParam}`
          : `${API_BASE_URL}/api/public/counseling/by-store/${storeId}`;
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      setSaveStatus("saved");
    } catch (err) {
      console.error("Failed to save:", err);
      setSaveStatus("idle");
    }
  }, [reservationId, storeId, intakeSessionId, walkinId, data]);

  const updateField = (categoryId: string, questionId: string, value: string | string[]) => {
    setData((prev) => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        [questionId]: value,
      },
    }));
    setSaveStatus("idle");
  };

  const getValue = (categoryId: string, questionId: string): string | string[] => {
    return data[categoryId]?.[questionId] ?? "";
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (saveStatus === "saved") {
    const pendingFriendUrl = searchParams.get("friend_url");

    const handleClose = async () => {
      if (pendingFriendUrl) {
        window.location.href = pendingFriendUrl;
        return;
      }
      try {
        const liff = (await import("@line/liff")).default;
        if (liff.isInClient()) {
          liff.closeWindow();
          return;
        }
      } catch {}
      window.close();
    };

    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <Check className="h-8 w-8 text-green-600" />
            </div>
            <h2 className="text-xl font-semibold">保存しました</h2>
            <p className="text-sm text-muted-foreground">
              ご記入ありがとうございます。<br />
              施術の参考にさせていただきます。
            </p>
            {!pendingFriendUrl && storeId && <LineFriendButton storeId={storeId} />}
            {isLiff || pendingFriendUrl ? (
              <Button
                onClick={handleClose}
                className="w-full bg-[#b8936a] hover:bg-[#a68059]"
              >
                閉じる
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                この画面を閉じてください。
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 pb-32 max-w-md mx-auto">
      <h1 className="text-xl font-bold mb-4">カウンセリングシート</h1>

      <Card className="mb-4">
        <CardContent className="p-4 space-y-1">
          <p className="text-sm font-medium">自分のこだわりや好みをご選択ください！</p>
          <p className="text-xs text-muted-foreground">
            ご記入いただいた内容は、施術担当者に共有され、当日スムーズに施術が始められます。全て任意でご入力いただけます。
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue={COUNSELING_CATEGORIES[0].id}>
        <TabsList className="w-full flex-wrap h-auto gap-1 p-1">
          {COUNSELING_CATEGORIES.map((cat) => (
            <TabsTrigger key={cat.id} value={cat.id} className="shrink-0 text-xs">
              {cat.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {COUNSELING_CATEGORIES.map((category) => (
          <TabsContent key={category.id} value={category.id} className="mt-4">
            <div className="space-y-5">
              {category.questions.map((question) => {
                if (question.showWhen) {
                  const refValue = getValue(category.id, question.showWhen.questionId);
                  if (!question.showWhen.values.includes(refValue as string)) return null;
                }
                return (
                  <QuestionField
                    key={question.id}
                    question={question}
                    value={getValue(category.id, question.id)}
                    onChange={(val) => updateField(category.id, question.id, val)}
                    getSubFieldValue={(subId) => getValue(category.id, subId) as string}
                    onSubFieldChange={(subId, val) => updateField(category.id, subId, val)}
                  />
                );
              })}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <div className="fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t p-3" style={{ paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom, 1rem))" }}>
        <div className="max-w-md mx-auto">
          <Button onClick={handleSave} disabled={saveStatus === "saving"} className="w-full">
            {saveStatus === "saving" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                保存中...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                保存
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface QuestionFieldProps {
  question: CounselingQuestion;
  value: string | string[];
  onChange: (value: string | string[]) => void;
  getSubFieldValue: (subId: string) => string;
  onSubFieldChange: (subId: string, value: string) => void;
}

function QuestionField({
  question,
  value,
  onChange,
  getSubFieldValue,
  onSubFieldChange,
}: QuestionFieldProps) {
  switch (question.type) {
    case "text":
      return (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{question.label}</Label>
          {question.label.includes("理由") || question.label.includes("質問") ? (
            <Textarea
              value={(value as string) || ""}
              onChange={(e) => onChange(e.target.value)}
              rows={2}
            />
          ) : (
            <Input
              value={(value as string) || ""}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      );

    case "radio":
      return (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{question.label}</Label>
          <div className="flex flex-wrap gap-2">
            {question.options?.map((option) => (
              <Badge
                key={option}
                variant={value === option ? "default" : "outline"}
                className="cursor-pointer px-3 py-1.5 text-sm transition-colors"
                onClick={() => onChange(value === option ? "" : option)}
              >
                {option}
              </Badge>
            ))}
          </div>
        </div>
      );

    case "multi_select":
      return (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{question.label}</Label>
          <div className="flex flex-wrap gap-2">
            {question.options?.map((option) => {
              const selected = Array.isArray(value) && value.includes(option);
              return (
                <Badge
                  key={option}
                  variant={selected ? "default" : "outline"}
                  className="cursor-pointer px-3 py-1.5 text-sm transition-colors"
                  onClick={() => {
                    const arr = Array.isArray(value) ? value : [];
                    if (selected) {
                      onChange(arr.filter((v) => v !== option));
                    } else {
                      onChange([...arr, option]);
                    }
                  }}
                >
                  {option}
                </Badge>
              );
            })}
          </div>
        </div>
      );

    case "slider":
      return (
        <div className="space-y-3">
          <Label className="text-sm font-medium">{question.label}</Label>
          <Slider
            value={[value === "" || value === undefined ? 50 : Number(value)]}
            onValueChange={([v]) => onChange(String(v))}
            max={100}
            step={25}
          />
          {question.sliderLabels && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{question.sliderLabels[0]}</span>
              <span>{question.sliderLabels[1]}</span>
            </div>
          )}
        </div>
      );

    case "radio_with_text":
      return (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{question.label}</Label>
          <div className="flex flex-wrap gap-2">
            {question.options?.map((option) => (
              <Badge
                key={option}
                variant={value === option ? "default" : "outline"}
                className="cursor-pointer px-3 py-1.5 text-sm transition-colors"
                onClick={() => onChange(value === option ? "" : option)}
              >
                {option}
              </Badge>
            ))}
          </div>
          {(() => {
            const trigger = question.subFieldTrigger ?? question.options?.[0];
            return question.subFields && (
              Array.isArray(trigger) ? trigger.includes(value as string) : value === trigger
            );
          })() && (
            <div className="ml-4 mt-2 space-y-2 border-l-2 pl-4">
              {question.subFields?.map((sub) => (
                <div key={sub.id} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{sub.label}</Label>
                  <Input
                    value={getSubFieldValue(sub.id) || ""}
                    onChange={(e) => onSubFieldChange(sub.id, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      );

    default:
      return null;
  }
}

function LineFriendButton({ storeId }: { storeId: string }) {
  const [friendUrl, setFriendUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/public/store/${storeId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.store?.line_friend_url) {
          setFriendUrl(data.store.line_friend_url);
        }
      })
      .catch(() => {});
  }, [storeId]);

  if (!friendUrl) return null;

  return (
    <a href={friendUrl} className="block">
      <Button
        type="button"
        className="w-full bg-[#06C755] hover:bg-[#05b04c] text-white"
      >
        <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 5.83 2 10.5c0 4.08 3.42 7.5 8.05 8.35.31.07.74.21.85.48.1.25.07.63.03.88l-.14.82c-.04.25-.2.97.85.53s5.61-3.3 7.65-5.65C21.22 13.78 22 12.2 22 10.5 22 5.83 17.52 2 12 2z"/></svg>
        LINEで友だち追加
      </Button>
    </a>
  );
}

export default function PublicCounselingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      }
    >
      <CounselingContent />
    </Suspense>
  );
}
