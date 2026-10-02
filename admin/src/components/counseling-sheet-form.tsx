"use client";

import { useEffect, useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { counselingSheets } from "@/lib/api";

type SaveStatus = "idle" | "saving" | "saved";

interface CounselingSheetFormProps {
  customerId: string;
  storeId?: string;
}

export function CounselingSheetForm({ customerId, storeId }: CounselingSheetFormProps) {
  const [data, setData] = useState<CounselingData>({});
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    const fetchSheet = async () => {
      try {
        const res = await counselingSheets.get(customerId, storeId);
        if (res.counseling_sheet) {
          setData(res.counseling_sheet.data);
        }
      } catch (error) {
        console.error("Failed to fetch counseling sheet:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchSheet();
  }, [customerId, storeId]);

  const handleSave = useCallback(async () => {
    setSaveStatus("saving");
    try {
      await counselingSheets.save(customerId, data, storeId);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save counseling sheet:", error);
      setSaveStatus("idle");
    }
  }, [customerId, data, storeId]);

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
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="relative">
      <Tabs defaultValue={COUNSELING_CATEGORIES[0].id}>
        <TabsList className="w-full justify-start overflow-x-auto">
          {COUNSELING_CATEGORIES.map((cat) => (
            <TabsTrigger key={cat.id} value={cat.id} className="shrink-0 text-xs sm:text-sm">
              {cat.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {COUNSELING_CATEGORIES.map((category) => (
          <TabsContent key={category.id} value={category.id} className="mt-4">
            <div className="space-y-4 pb-16">
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
      <div className="sticky bottom-0 left-0 right-0 bg-background/95 backdrop-blur border-t p-3 -mx-6 -mb-6 px-6">
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
