import { useState } from 'react';
import { Button, Input } from '../ui';

/** Read-only URL with copy / open buttons */
export function CopyLink({ url, label = 'リンク' }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (http / permissions): the input stays selectable */
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={url}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
        data-testid="copy-link-url"
      />
      <Button
        size="md"
        icon={copied ? 'check' : 'copy'}
        onClick={() => void copy()}
        aria-live="polite"
      >
        {copied ? 'コピー済' : 'コピー'}
      </Button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-2"
        aria-label="新しいタブで開く"
        title="新しいタブで開く"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden
        >
          <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
      </a>
    </div>
  );
}
