import { config } from '../../../config.js';
import { createAnthropicProvider } from './anthropic.js';
import { heuristicProvider } from './heuristic.js';
import type { AiProvider, AiResult, AiTask } from './types.js';

let override: AiProvider | null = null;

/** Tests may pin a provider; pass null to restore config-based selection */
export function setAiProvider(provider: AiProvider | null) {
  override = provider;
}

/** Anthropic when ANTHROPIC_API_KEY is configured, otherwise the deterministic heuristic templates */
export function currentProvider(): AiProvider {
  if (override) return override;
  if (config.ANTHROPIC_API_KEY) return createAnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL });
  return heuristicProvider;
}

/** Generate with graceful degradation: provider failures fall back to the heuristic templates */
export async function generate(task: AiTask): Promise<AiResult> {
  const provider = currentProvider();
  if (provider.name === 'heuristic') return provider.generate(task);
  try {
    return await provider.generate(task);
  } catch (err) {
    const result = await heuristicProvider.generate(task);
    return { ...result, fallbackReason: `${provider.name}: ${(err as Error).message}`.slice(0, 300) };
  }
}

export { heuristicProvider };
export type { AiProvider, AiResult, AiTask };
