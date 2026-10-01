import type { BookingProviderAdapter } from './types.js';

const adapters = new Map<string, BookingProviderAdapter>();

export function registerAdapter(adapter: BookingProviderAdapter) {
  if (adapters.has(adapter.name)) throw new Error(`integration adapter already registered: ${adapter.name}`);
  adapters.set(adapter.name, adapter);
}

export function getAdapter(provider: string): BookingProviderAdapter | undefined {
  return adapters.get(provider);
}

export function registeredAdapters(): string[] {
  return [...adapters.keys()];
}
