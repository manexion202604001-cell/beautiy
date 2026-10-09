import { describe, expect, it } from 'vitest';
import { decodeTextFile } from './decode';

describe('decodeTextFile', () => {
  it('keeps UTF-8 (with BOM) and falls back to Shift_JIS', () => {
    const utf8 = new TextEncoder().encode('﻿氏名,電話\n山田 花子,090');
    expect(decodeTextFile(utf8.buffer as ArrayBuffer)).toContain('山田 花子');
    // "山田,090" in Shift_JIS
    const sjis = new Uint8Array([0x8e, 0x52, 0x93, 0x63, 0x2c, 0x30, 0x39, 0x30]);
    expect(decodeTextFile(sjis.buffer)).toBe('山田,090');
  });
});
