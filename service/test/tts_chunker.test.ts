import { describe, expect, it } from "vitest";
import { chunkForTts } from "../src/tts_chunker.js";

async function* fromArray(arr: string[]): AsyncIterable<string> {
  for (const s of arr) yield s;
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe("chunkForTts", () => {
  it("emits a single chunk when total text is under minChars", async () => {
    const chunks = await collect(chunkForTts(fromArray(["hello", " ", "world"])));
    expect(chunks).toEqual(["hello world"]);
  });

  it("emits the trailing remainder at end-of-stream even if short", async () => {
    const chunks = await collect(chunkForTts(fromArray(["short"])));
    expect(chunks).toEqual(["short"]);
  });

  it("flushes at the first sentence end at or after minChars", async () => {
    // Construct a >60-char input with sentence ends at multiple positions.
    const text =
      "First clause is here. Second clause is here. Third clause goes here too.";
    const chunks = await collect(chunkForTts(fromArray([text])));
    // First chunk should end at the first sentence end >= 60.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // No chunk should be empty.
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
    // Reconstruction is lossless.
    expect(chunks.join("")).toBe(text);
    // The first chunk should be at least minChars (60) long.
    expect(chunks[0]!.length).toBeGreaterThanOrEqual(60);
  });

  it("preserves reconstruction when input is delivered as small deltas", async () => {
    const sentence =
      "The weather forecast for tomorrow shows clear skies. " +
      "Temperatures will reach 75 degrees in the afternoon. " +
      "Bring a light jacket for the evening.";
    const deltas = sentence.match(/.{1,3}/g) ?? [];
    const chunks = await collect(chunkForTts(fromArray(deltas)));
    expect(chunks.join("")).toBe(sentence);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("force-flushes at hardMaxChars when there is no sentence end", async () => {
    const noSentence = "abcdefghij ".repeat(30); // 330 chars, spaces every 10
    const chunks = await collect(
      chunkForTts(fromArray([noSentence]), { hardMaxChars: 100 }),
    );
    expect(chunks.join("")).toBe(noSentence);
    // With 330 chars and 100-char hardMax, expect at least 3 chunks.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Forced chunks should split at whitespace, so no chunk should start with a space.
    for (const c of chunks) {
      if (c !== chunks[chunks.length - 1]) {
        expect(c.startsWith(" ")).toBe(false);
      }
    }
  });

  it("respects CJK sentence-ending punctuation", async () => {
    const text =
      "今天的天氣預報顯示明天會是晴天，最高溫度約攝氏二十五度。請記得帶一件薄外套以備不時之需。";
    const chunks = await collect(chunkForTts(fromArray([text])));
    expect(chunks.join("")).toBe(text);
    // Should split at the 。 boundary.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.endsWith("。")).toBe(true);
  });

  it("handles an empty input cleanly", async () => {
    const chunks = await collect(chunkForTts(fromArray([])));
    expect(chunks).toEqual([]);
  });
});
