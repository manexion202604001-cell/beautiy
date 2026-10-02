"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Save, Check, Loader2 } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import {
  COUNSELING_CATEGORIES,
  type CounselingCategory,
  type CounselingQuestion,
  type CounselingData,
} from "@/lib/counseling-questions";
import { counselingSheetApi } from "@/lib/api";

type SaveStatus = "idle" | "saving" | "saved";

export default function CounselingPage() {
  const [data, setData] = useState<CounselingData>({});
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    counselingSheetApi
      .get()
      .then((res) => {
        if (res.counseling_sheet) {
          setData(res.counseling_sheet.data);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaveStatus("saving");
    try {
      await counselingSheetApi.save(data);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save counseling sheet:", error);
      setSaveStatus("idle");
    }
  }, [data]);

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

  return (
    <div className="p-4 pb-24">
      <div className="flex items-center gap-2 mb-4">
        <Link href="/mypage">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="text-xl font-bold">カウンセリングシート</h1>
      </div>

      {/* Description */}
      <Card className="mb-4">
        <CardContent className="p-4 space-y-1">
          <p className="text-sm font-medium">自分のこだわりや好みを選択しよう！</p>
          <p className="text-xs text-muted-foreground">
            このシートを記入しておけば、当日スムースに始められます。
          </p>
          <p className="text-xs text-muted-foreground">
            記入した内容は担当者さんに共有され施術担当時の参考になります！
          </p>
          <p className="text-xs text-muted-foreground">
            全て任意で入力いただけます。
          </p>
        </CardContent>
      </Card>

      <Tabs defaultValue={COUNSELING_CATEGORIES[0].id}>
        <TabsList className="w-full justify-start overflow-x-auto">
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
                    category={category}
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

      {/* Floating save button */}
      <div className="fixed bottom-16 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t p-3 safe-area-bottom">
        <div className="max-w-md mx-auto">
          <Button onClick={handleSave} disabled={saveStatus === "saving"} className="w-full">
            {saveStatus === "saving" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                保存中...
              </>
            ) : saveStatus === "saved" ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                保存しました
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
  category: CounselingCategory;
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
