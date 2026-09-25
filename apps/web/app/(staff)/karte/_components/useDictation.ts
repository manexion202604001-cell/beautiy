'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/* Minimal typings for the Web Speech API (not in lib.dom for all TS versions). */
interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type Ctor = new () => SpeechRecognitionLike;

function recognitionCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'マイクの使用が許可されていません。ブラウザの設定を確認してください。',
  'service-not-allowed': 'このブラウザでは音声入力が利用できません。',
  'no-speech': '音声が検出されませんでした。',
  'audio-capture': 'マイクが見つかりません。',
  network: '音声認識サービスに接続できませんでした。',
};

/**
 * Speech-to-text (ja-JP) via the browser Web Speech API. Final phrases are passed to `onText`;
 * interim text is exposed for display. `supported` is false where the API is unavailable.
 */
export function useDictation(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const cb = useRef(onText);
  cb.current = onText;

  useEffect(() => { setSupported(!!recognitionCtor()); return () => rec.current?.abort(); }, []);

  const start = useCallback(() => {
    const C = recognitionCtor();
    if (!C) { setError('このブラウザは音声入力に対応していません（Chrome / Safari / Edge をご利用ください）'); return; }
    rec.current?.abort();
    const r = new C();
    r.lang = 'ja-JP';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let fin = '', mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) fin += res[0].transcript; else mid += res[0].transcript;
      }
      if (fin) cb.current(fin);
      setInterim(mid);
    };
    r.onerror = (e) => { if (e.error !== 'aborted') setError(ERRORS[e.error] ?? `音声入力エラー: ${e.error}`); };
    r.onend = () => { setListening(false); setInterim(''); };
    try {
      r.start();
      rec.current = r;
      setError(null);
      setListening(true);
    } catch (e) {
      setError('音声入力を開始できませんでした');
    }
  }, []);

  const stop = useCallback(() => { rec.current?.stop(); }, []);
  const toggle = useCallback(() => (listening ? stop() : start()), [listening, start, stop]);

  return { supported, listening, interim, error, start, stop, toggle };
}
