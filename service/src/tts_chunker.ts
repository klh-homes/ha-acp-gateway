export interface TtsChunkerOptions {
  /** Minimum chunk size in characters before a flush is attempted (default 60). */
  minChars?: number;
  /**
   * Hard upper bound on buffered chars. Once reached, the buffer is force-flushed
   * at the last whitespace (or at hardMaxChars if no whitespace is found).
   */
  hardMaxChars?: number;
}

/**
 * Re-shapes a stream of small text deltas (e.g. ACP agent_message_chunk events)
 * into TTS-friendly chunks. Behavior:
 *
 * 1. Buffer until at least `minChars` characters are queued.
 * 2. Emit at the first sentence-ending punctuation occurring at or after the
 *    minChars boundary. ASCII (. ! ?) and CJK (。！？) punctuation count.
 * 3. If no sentence end is found and the buffer reaches `hardMaxChars`, force
 *    a flush at the last whitespace before the cap (or at the cap itself for
 *    languages without spaces).
 * 4. At end of input, emit whatever is left in the buffer.
 *
 * The default (60 / 200) matches the V1 plan: TTS engines sound choppy on
 * sub-60-char chunks, and 200 is a soft ceiling so a slow agent doesn't
 * delay the first audible reply indefinitely.
 */
export async function* chunkForTts(
  deltas: AsyncIterable<string>,
  opts: TtsChunkerOptions = {},
): AsyncIterable<string> {
  const minChars = opts.minChars ?? 60;
  const hardMaxChars = opts.hardMaxChars ?? 200;
  let buffer = "";

  for await (const delta of deltas) {
    buffer += delta;
    while (buffer.length >= minChars) {
      const sentenceEnd = findFirstSentenceEndAtOrAfter(buffer, minChars);
      if (sentenceEnd !== -1) {
        yield buffer.slice(0, sentenceEnd);
        buffer = buffer.slice(sentenceEnd);
        continue;
      }
      if (buffer.length >= hardMaxChars) {
        const wsPos = buffer.lastIndexOf(" ", hardMaxChars - 1);
        const cut = wsPos > minChars ? wsPos + 1 : hardMaxChars;
        yield buffer.slice(0, cut);
        buffer = buffer.slice(cut);
        continue;
      }
      break;
    }
  }
  if (buffer.length > 0) yield buffer;
}

const SENTENCE_END_RE = /[.!?。！？]\s*/g;

function findFirstSentenceEndAtOrAfter(s: string, minPos: number): number {
  SENTENCE_END_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END_RE.exec(s)) !== null) {
    const endPos = m.index + m[0].length;
    if (endPos >= minPos) return endPos;
  }
  return -1;
}
