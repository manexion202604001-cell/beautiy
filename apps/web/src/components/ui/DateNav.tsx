import { useId } from 'react';
import { formatDateJa } from '../../lib/format';
import { addDays } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Button, IconButton } from './Button';

/** Prev / Today / Next + native date picker. step = days per prev/next (1 day or 7 for week) */
export function DateNav({
  value,
  onChange,
  today,
  step = 1,
  label,
  className,
}: {
  value: string;
  onChange: (date: string) => void;
  today: string;
  step?: number;
  label?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <IconButton
        icon="chevron-left"
        label={step === 7 ? '前の週' : '前の日'}
        variant="secondary"
        size="sm"
        onClick={() => onChange(addDays(value, -step))}
      />
      <Button
        size="sm"
        variant={value === today ? 'soft' : 'secondary'}
        onClick={() => onChange(today)}
      >
        今日
      </Button>
      <IconButton
        icon="chevron-right"
        label={step === 7 ? '次の週' : '次の日'}
        variant="secondary"
        size="sm"
        onClick={() => onChange(addDays(value, step))}
      />
      <label htmlFor={id} className="sr-only">
        日付を選択
      </label>
      <div className="relative ml-1">
        <span
          className="pointer-events-none block min-w-[9.5rem] rounded-lg px-2 py-1 text-[15px] font-semibold text-fg"
          aria-hidden
        >
          {label ?? formatDateJa(value, { year: true })}
        </span>
        <input
          id={id}
          type="date"
          value={value}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
}
