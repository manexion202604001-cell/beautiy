"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Check, Loader2, FileText } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { BirthdayPicker } from "@/components/drum-picker";

interface ConsentSection {
  title: string;
  items: string[];
}

interface FormField {
  name: string;
  label: string;
  type: string;
  required: boolean;
}

interface ConsentTemplate {
  id: string;
  store_id: string;
  title: string;
  description: string | null;
  sections: ConsentSection[];
  form_fields: FormField[] | null;
  version: string | null;
}

const DEFAULT_FORM_FIELDS: FormField[] = [
  { name: "customer_name", label: "お名前", type: "text", required: true },
  {
    name: "customer_birthday",
    label: "生年月日",
    type: "date",
    required: true,
  },
  {
    name: "customer_phone",
    label: "電話番号",
    type: "tel",
    required: true,
  },
  {
    name: "customer_occupation",
    label: "ご職業",
    type: "text",
    required: false,
  },
  {
    name: "customer_visit_reason",
    label: "ご来店のきっかけ",
    type: "text",
    required: false,
  },
];

export default function ConsentPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      }
    >
      <ConsentPageContent />
    </Suspense>
  );
}

function ConsentPageContent() {
  const searchParams = useSearchParams();
  const templateId = searchParams.get("id");
  const storeId = searchParams.get("store_id");
  const reservationId = searchParams.get("reservation_id");
  const intakeSessionId = searchParams.get("intake_session_id");
  const token = searchParams.get("token");
  const staffId = searchParams.get("staff_id");
  const isWalkin = searchParams.get("walkin") === "1";

  const [template, setTemplate] = useState<ConsentTemplate | null>(null);
  const [resolvedTemplateId, setResolvedTemplateId] = useState<string | null>(templateId);
  const [storeName, setStoreName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [openSections, setOpenSections] = useState<Record<number, boolean>>({});
  const [parentAgreed, setParentAgreed] = useState(false);
  const [isReturningCustomer, setIsReturningCustomer] = useState(false);
  const [walkinId, setWalkinId] = useState<string | null>(null);

  useEffect(() => {
    if (!templateId && !storeId) {
      setError("同意書IDが指定されていません");
      setLoading(false);
      return;
    }

    // Pre-fill name from intake session and detect returning customer
    if (intakeSessionId) {
      fetch(`${API_BASE_URL}/api/public/intake/${intakeSessionId}`)
        .then(res => res.json())
        .then(data => {
          if (data.session?.name) {
            setFormData(prev => ({ ...prev, customer_name: data.session.name }));
          }
          // Returning customer: session_type is 'returning' (set during intake type selection)
          if (data.session?.session_type === 'returning') {
            setIsReturningCustomer(true);
            // Fetch customer name if not in session
            if (!data.session?.name && data.session?.customer_id) {
              fetch(`${API_BASE_URL}/api/public/intake/${intakeSessionId}/counseling`)
                .then(r => r.json())
                .then(d => {
                  if (d.customer?.name) {
                    setFormData(prev => ({ ...prev, customer_name: d.customer.name }));
                  }
                })
                .catch(() => {});
            }
          }
        })
        .catch(() => {});
      // Update intake status to consent
      fetch(`${API_BASE_URL}/api/public/intake/${intakeSessionId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "consent" }),
      }).catch(() => {});
    }

    const url = templateId
      ? `${API_BASE_URL}/api/public/consent/${templateId}`
      : `${API_BASE_URL}/api/public/consent/by-store/${storeId}`;

    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("同意書が見つかりません");
        }
        return res.json();
      })
      .then(
        (data: { template: ConsentTemplate; store_name: string | null }) => {
          setTemplate(data.template);
          setResolvedTemplateId(data.template.id);
          setStoreName(data.store_name);
          const open: Record<number, boolean> = {};
          data.template.sections.forEach((_, i) => {
            open[i] = true;
          });
          setOpenSections(open);
        }
      )
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [templateId, storeId]);

  const formFields = template?.form_fields || DEFAULT_FORM_FIELDS;

  const getAge = (birthdayStr: string): number => {
    const birth = new Date(birthdayStr);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && today.getDate() < birth.getDate())
    ) {
      age--;
    }
    return age;
  };

  const isFormValid = () => {
    if (!agreed) return false;
    // Returning customers only need to agree, no form required
    if (isReturningCustomer) return true;
    for (const field of formFields) {
      if (field.required && !formData[field.name]?.trim()) {
        return false;
      }
    }
    const isMinor = formData.customer_birthday && getAge(formData.customer_birthday) < 18;
    if (isMinor && (!parentAgreed || !formData.parent_name?.trim())) {
      return false;
    }
    return true;
  };

  const handleSubmit = async () => {
    if (!isFormValid() || !resolvedTemplateId) return;
    setSubmitting(true);

    try {
      const submitUrl = token
        ? `${API_BASE_URL}/api/public/consent/${resolvedTemplateId}/submit?token=${token}`
        : `${API_BASE_URL}/api/public/consent/${resolvedTemplateId}/submit`;
      const res = await fetch(
        submitUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...formData,
            ...(reservationId ? { reservation_id: reservationId } : {}),
            ...(isWalkin ? { walkin: true, staff_id: staffId || undefined } : {}),
          }),
        }
      );

      if (!res.ok) {
        const data = await res
          .json()
          .catch(() => ({ error: "送信に失敗しました" }));
        throw new Error((data as { error: string }).error);
      }

      const result = await res.json().catch(() => ({}));
      if ((result as { walkin_id?: string }).walkin_id) {
        setWalkinId((result as { walkin_id: string }).walkin_id);
      }
      setSubmitted(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleSection = (index: number) => {
    setOpenSections((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-muted-foreground">
              {error || "同意書が見つかりません"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    const counselingStoreId = template?.store_id || storeId;
    // Pass name and birthday from consent form to counseling sheet
    const prefillParams = new URLSearchParams();
    if (formData.customer_name) prefillParams.set("prefill_name", formData.customer_name);
    if (formData.customer_birthday) prefillParams.set("prefill_birthday", formData.customer_birthday);
    if (formData.customer_phone) prefillParams.set("prefill_phone", formData.customer_phone);
    const prefillStr = prefillParams.toString();

    const friendUrlParam = searchParams.get("friend_url");
    const friendStr = friendUrlParam ? `&friend_url=${encodeURIComponent(friendUrlParam)}` : "";

    const tokenStr = token ? `&token=${token}` : "";
    const counselingParams = walkinId
      ? `walkin_id=${walkinId}&store_id=${counselingStoreId}${prefillStr ? `&${prefillStr}` : ""}`
      : intakeSessionId
      ? `intake_session_id=${intakeSessionId}&store_id=${counselingStoreId}${prefillStr ? `&${prefillStr}` : ""}${friendStr}${tokenStr}`
      : reservationId
        ? `reservation_id=${reservationId}${prefillStr ? `&${prefillStr}` : ""}${friendStr}${tokenStr}`
        : counselingStoreId
          ? `store_id=${counselingStoreId}${prefillStr ? `&${prefillStr}` : ""}${friendStr}${tokenStr}`
          : null;
    const counselingUrl = counselingParams ? `/counseling?${counselingParams}` : null;

    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
              <Check className="h-8 w-8 text-green-600" />
            </div>
            <h2 className="text-xl font-semibold">同意書を提出しました</h2>
            <p className="text-sm text-muted-foreground">
              ご提出ありがとうございます。
            </p>
            {counselingUrl && (
              <div className="pt-2">
                <p className="text-sm text-muted-foreground mb-3">
                  続いてカウンセリングシートのご記入をお願いいたします。
                </p>
                <Button
                  size="xl"
                  className="w-full"
                  onClick={() => window.location.href = counselingUrl}
                >
                  カウンセリングシートへ進む
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-primary text-primary-foreground py-6 px-4 text-center">
        {storeName && <p className="text-sm opacity-80 mb-1">{storeName}</p>}
        <h1 className="text-xl font-bold">{template.title}</h1>
        {template.description && (
          <p className="text-sm mt-1 opacity-90">{template.description}</p>
        )}
      </div>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Introduction */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <FileText className="h-5 w-5 text-primary mt-0.5 shrink-0" />
              <p className="text-sm leading-relaxed">
                私は以下の条件のもとで、施術を受ける事を同意、承諾いたします。
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Consent Sections */}
        {template.sections.map((section, index) => (
          <Collapsible
            key={index}
            open={openSections[index]}
            onOpenChange={() => toggleSection(index)}
          >
            <Card>
              <CollapsibleTrigger asChild>
                <button className="w-full px-6 py-4 flex items-center justify-between text-left">
                  <h3 className="font-semibold text-sm">{section.title}</h3>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${
                      openSections[index] ? "rotate-180" : ""
                    }`}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-6 pb-4">
                  <ul className="space-y-2">
                    {section.items.map((item, itemIndex) => (
                      <li
                        key={itemIndex}
                        className="text-sm text-muted-foreground leading-relaxed pl-1"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ))}

        {/* Customer Info Form (skip for returning customers) */}
        {!isReturningCustomer && (
          <>
            <Card>
              <CardContent className="pt-6 space-y-4">
                <h3 className="font-semibold text-sm">お客様情報</h3>

                {formFields.map((field) => (
                  <div key={field.name} className="space-y-2">
                    <Label htmlFor={field.name}>
                      {field.label}
                      {field.required && (
                        <span className="text-destructive ml-1">*</span>
                      )}
                    </Label>
                    {field.type === "date" ? (
                      <BirthdayPicker
                        value={formData[field.name] || ""}
                        onChange={(val) =>
                          setFormData((prev) => ({ ...prev, [field.name]: val }))
                        }
                      />
                    ) : (
                      <Input
                        id={field.name}
                        type={field.type}
                        value={formData[field.name] || ""}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            [field.name]: e.target.value,
                          }))
                        }
                        required={field.required}
                      />
                    )}
                    {field.name === "customer_birthday" &&
                      formData.customer_birthday &&
                      getAge(formData.customer_birthday) < 18 && (
                        <p className="text-xs text-amber-600">
                          未成年の方は保護者の同意が必要です
                        </p>
                      )}
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Parent/Guardian Consent for Minors */}
            {formData.customer_birthday && getAge(formData.customer_birthday) < 18 && (
              <Card className="border-amber-300 bg-amber-50">
                <CardContent className="pt-6 space-y-4">
                  <h3 className="font-semibold text-sm">保護者の同意</h3>
                  <p className="text-sm text-muted-foreground">
                    未成年の方は、保護者の同意が必要です。
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="parent_name">
                      保護者氏名
                      <span className="text-destructive ml-1">*</span>
                    </Label>
                    <Input
                      id="parent_name"
                      type="text"
                      value={formData.parent_name || ""}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          parent_name: e.target.value,
                        }))
                      }
                      required
                    />
                  </div>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={parentAgreed}
                      onChange={(e) => setParentAgreed(e.target.checked)}
                      className="mt-0.5 h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary accent-[hsl(31.5,35.5%,56.9%)]"
                    />
                    <span className="text-sm">
                      保護者として、上記の施術内容に同意します
                    </span>
                  </label>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Agreement Checkbox */}
        <Card>
          <CardContent className="pt-6">
            <h3 className="font-semibold text-sm mb-4">ご確認ください</h3>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-5 w-5 rounded border-gray-300 text-primary focus:ring-primary accent-[hsl(31.5,35.5%,56.9%)]"
              />
              <span className="text-sm">上記の内容に同意します</span>
            </label>
          </CardContent>
        </Card>

        {/* Submit Button */}
        <Button
          size="xl"
          className="w-full"
          disabled={!isFormValid() || submitting}
          onClick={handleSubmit}
        >
          {submitting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              送信中...
            </>
          ) : (
            isReturningCustomer ? "同意します" : "同意書を提出する"
          )}
        </Button>

        {/* Version info */}
        {template.version && (
          <p className="text-xs text-center text-muted-foreground pb-4">
            {template.version}
          </p>
        )}
      </div>
    </div>
  );
}
