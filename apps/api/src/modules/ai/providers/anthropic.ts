import { buildUserPrompt, SYSTEM_PROMPT, type AiProvider, type AiResult, type AiTask } from './types.js';

/**
 * Anthropic Messages API client over plain fetch (no npm dependency, CONVENTIONS §9).
 *   POST {baseUrl}/v1/messages   headers: x-api-key, anthropic-version: 2023-06-01
 * Only minimized task input (first name + visit summary, PII-scrubbed free text) is sent.
 * Output is always stored as a proposed suggestion — nothing is ever sent to customers automatically.
 */
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** Models that accept output_config.effort (lower effort = less thinking for short drafting tasks) */
const EFFORT_MODELS = new Set([
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);
/** Models supporting server-side refusal fallbacks (`fallbacks: "default"`) */
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly type: string,
  ) {
    super(message);
    this.name = 'AnthropicError';
  }
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  model?: string;
  stop_reason?: string | null;
  content?: { type: string; text?: string }[];
  usage?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

export function buildRequestBody(task: AiTask, model: string, maxTokens: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(task) }],
  };
  if (EFFORT_MODELS.has(model)) body.output_config = { effort: 'low' };
  if (SERVER_FALLBACK_MODELS.has(model)) body.fallbacks = 'default';
  return body;
}

export function createAnthropicProvider(opts: AnthropicOptions): AiProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const maxTokens = opts.maxTokens ?? 8000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    name: 'anthropic',
    async generate(task: AiTask): Promise<AiResult> {
      const doFetch = opts.fetchImpl ?? globalThis.fetch;
      const body = buildRequestBody(task, opts.model, maxTokens);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      };
      if (body.fallbacks) headers['anthropic-beta'] = SERVER_FALLBACK_BETA;
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const timeout = (err as { name?: string }).name === 'TimeoutError';
        throw new AnthropicError(timeout ? 'Anthropic API timeout' : `Anthropic API unreachable: ${(err as Error).message}`, null, timeout ? 'timeout' : 'network');
      }
      let json: MessagesResponse;
      try {
        json = (await res.json()) as MessagesResponse;
      } catch {
        throw new AnthropicError(`Anthropic API returned non-JSON (HTTP ${res.status})`, res.status, 'invalid_response');
      }
      if (!res.ok) {
        throw new AnthropicError(json.error?.message ?? `HTTP ${res.status}`, res.status, json.error?.type ?? 'api_error');
      }
      // safety classifiers may decline (HTTP 200 + stop_reason "refusal") — check before reading content
      if (json.stop_reason === 'refusal') throw new AnthropicError('request declined (refusal)', res.status, 'refusal');
      const text = (json.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) throw new AnthropicError(`empty response (stop_reason=${json.stop_reason ?? 'unknown'})`, res.status, 'empty');
      return { text, provider: 'anthropic', model: json.model ?? opts.model, usage: json.usage };
    },
  };
}
