/**
 * Decode an uploaded CSV/text file. Exports from Japanese salon systems and Excel are often
 * Shift_JIS: when UTF-8 decoding yields replacement characters (U+FFFD), decode as Shift_JIS.
 * (Checked by char code so no literal U+FFFD ends up in the bundle.)
 */
export function decodeTextFile(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  for (let i = 0; i < utf8.length; i++) {
    if (utf8.charCodeAt(i) === 0xfffd) return new TextDecoder('shift_jis').decode(buf);
  }
  return utf8;
}
