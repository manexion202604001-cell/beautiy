import { Check, LoaderCircle, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { kartesApi, type CounselingSheetData } from '../../../api/kartes';
import { Badge, Button, Input, Label, Tabs, Textarea } from '../../../components/shad';
import { Slider } from '../../../components/shad/slider';
import { useToast } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { COUNSELING_CATEGORIES, type CounselingQuestion } from './counselingQuestions';

type Answer = string | string[];

/**
 * カウンセリングシート of a customer: one tab per category, answers kept as the staff member taps
 * them and written with 保存. `shopId` is the shop the sheet is being filled in at.
 */
export function CounselingSheet({ customerId, shopId }: { customerId: string; shopId?: string | null }) {
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<CounselingSheetData>({});
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [category, setCategory] = useState(COUNSELING_CATEGORIES[0]!.id);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    kartesApi
      .counselingSheet(customerId)
      .then((res) => {
        if (!cancelled) setData(res.counseling_sheet?.data ?? {});
      })
      .catch((e: unknown) => {
        if (!cancelled) toast.error('カウンセリングシートの取得に失敗しました', errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, toast]);

  useEffect(
    () => () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const save = useCallback(async () => {
    setState('saving');
    try {
      await kartesApi.saveCounselingSheet(customerId, data, shopId);
      setState('saved');
      savedTimer.current = window.setTimeout(() => setState('idle'), 2000);
    } catch (e) {
      toast.error('カウンセリングシートの保存に失敗しました', errorMessage(e));
      setState('idle');
    }
  }, [customerId, data, shopId, toast]);

  const setAnswer = (categoryId: string, questionId: string, value: Answer) => {
    setData((d) => ({ ...d, [categoryId]: { ...d[categoryId], [questionId]: value } }));
    setState('idle');
  };
  const answer = (categoryId: string, questionId: string): Answer => data[categoryId]?.[questionId] ?? '';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const current = COUNSELING_CATEGORIES.find((c) => c.id === category) ?? COUNSELING_CATEGORIES[0]!;
  const canWrite = can('karte.write');

  return (
    <div className="relative">
      <Tabs
        label="カウンセリングの種類"
        value={current.id}
        onValueChange={setCategory}
        listClassName="w-full justify-start overflow-x-auto"
        triggerClassName="shrink-0 text-xs sm:text-sm"
        items={COUNSELING_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))}
      />
      <div role="tabpanel" className="mt-4">
        <div className="sy-4 pb-16">
          {current.questions.map((q) => {
            if (q.showWhen) {
              const other = answer(current.id, q.showWhen.questionId);
              if (typeof other !== 'string' || !q.showWhen.values.includes(other)) return null;
            }
            return (
              <Question
                key={q.id}
                question={q}
                value={answer(current.id, q.id)}
                onChange={(v) => setAnswer(current.id, q.id, v)}
                subFieldValue={(id) => answer(current.id, id)}
                onSubFieldChange={(id, v) => setAnswer(current.id, id, v)}
              />
            );
          })}
        </div>
      </div>
      <div className="sticky bottom-0 left-0 right-0 -mx-6 -mb-6 border-t bg-background/95 p-3 px-6 backdrop-blur">
        <Button onClick={() => void save()} disabled={state === 'saving' || !canWrite} className="w-full">
          {state === 'saving' ? (
            <>
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
              保存中...
            </>
          ) : state === 'saved' ? (
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

function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string }) {
  return (
    <Badge
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      variant={selected ? 'default' : 'outline'}
      className="cursor-pointer px-3 py-1.5 text-sm transition-colors"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </Badge>
  );
}

function Question({
  question: q,
  value,
  onChange,
  subFieldValue,
  onSubFieldChange,
}: {
  question: CounselingQuestion;
  value: Answer;
  onChange: (value: Answer) => void;
  subFieldValue: (id: string) => Answer;
  onSubFieldChange: (id: string, value: string) => void;
}) {
  const text = typeof value === 'string' ? value : '';
  switch (q.type) {
    case 'text':
      return (
        <div className="sy-2">
          <Label className="text-sm font-medium">{q.label}</Label>
          {q.label.includes('理由') || q.label.includes('質問') ? (
            <Textarea aria-label={q.label} value={text} onChange={(e) => onChange(e.target.value)} rows={2} />
          ) : (
            <Input aria-label={q.label} value={text} onChange={(e) => onChange(e.target.value)} />
          )}
        </div>
      );
    case 'radio':
      return (
        <div className="sy-2">
          <Label className="text-sm font-medium">{q.label}</Label>
          <div className="flex flex-wrap gap-2">
            {q.options?.map((o) => (
              <Choice key={o} selected={value === o} onClick={() => onChange(value === o ? '' : o)}>
                {o}
              </Choice>
            ))}
          </div>
        </div>
      );
    case 'multi_select': {
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="sy-2">
          <Label className="text-sm font-medium">{q.label}</Label>
          <div className="flex flex-wrap gap-2">
            {q.options?.map((o) => {
              const selected = list.includes(o);
              return (
                <Choice key={o} selected={selected} onClick={() => onChange(selected ? list.filter((x) => x !== o) : [...list, o])}>
                  {o}
                </Choice>
              );
            })}
          </div>
        </div>
      );
    }
    case 'slider':
      return (
        <div className="sy-3">
          <Label className="text-sm font-medium">{q.label}</Label>
          <Slider
            label={q.label}
            value={text === '' ? 50 : Number(text)}
            onValueChange={(v) => onChange(String(v))}
            max={100}
            step={25}
          />
          {q.sliderLabels ? (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{q.sliderLabels[0]}</span>
              <span>{q.sliderLabels[1]}</span>
            </div>
          ) : null}
        </div>
      );
    case 'radio_with_text': {
      const trigger = q.subFieldTrigger ?? q.options?.[0];
      const open = !!q.subFields && (Array.isArray(trigger) ? trigger.includes(text) : value === trigger);
      return (
        <div className="sy-2">
          <Label className="text-sm font-medium">{q.label}</Label>
          <div className="flex flex-wrap gap-2">
            {q.options?.map((o) => (
              <Choice key={o} selected={value === o} onClick={() => onChange(value === o ? '' : o)}>
                {o}
              </Choice>
            ))}
          </div>
          {open ? (
            <div className="ml-4 mt-2 sy-2 border-l-2 pl-4">
              {q.subFields?.map((f) => {
                const v = subFieldValue(f.id);
                return (
                  <div key={f.id} className="sy-1">
                    <Label className="text-xs text-muted-foreground">{f.label}</Label>
                    <Input
                      aria-label={f.label}
                      value={typeof v === 'string' ? v : ''}
                      onChange={(e) => onSubFieldChange(f.id, e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      );
    }
    default:
      return null;
  }
}
