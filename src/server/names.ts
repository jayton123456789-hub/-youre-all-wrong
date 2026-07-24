const FORBIDDEN_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export type NameResult = { ok: true; name: string } | { ok: false; message: string };

export function normalizeDisplayName(input: string): NameResult {
  const normalized = input.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return { ok: false, message: 'Your name cannot be empty.' };
  }
  if (FORBIDDEN_NAME_CHARACTERS.test(normalized)) {
    return { ok: false, message: 'That name contains unsupported control characters.' };
  }

  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(normalized)];
  if (graphemes.length > 18) {
    return { ok: false, message: 'Keep your name to 18 characters or fewer.' };
  }

  return { ok: true, name: normalized };
}
