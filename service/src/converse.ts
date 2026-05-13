import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "./logger.js";

interface ConverseMessage {
  role: string;
  content: string;
}

interface ConverseRequest {
  conversation_id: string;
  messages: ConverseMessage[];
  max_tokens?: number;
}

function validateBody(body: unknown): ConverseRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (typeof b.conversation_id !== "string" || b.conversation_id === "") {
    return null;
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) return null;

  const messages: ConverseMessage[] = [];
  for (const m of b.messages) {
    if (typeof m !== "object" || m === null) return null;
    const msg = m as Record<string, unknown>;
    if (typeof msg.role !== "string" || typeof msg.content !== "string") {
      return null;
    }
    messages.push({ role: msg.role, content: msg.content });
  }

  const out: ConverseRequest = {
    conversation_id: b.conversation_id,
    messages,
  };
  if (b.max_tokens !== undefined) {
    if (typeof b.max_tokens !== "number" || b.max_tokens <= 0) return null;
    out.max_tokens = b.max_tokens;
  }
  return out;
}

const ECHO_CHUNK_SIZE = 12;
const ECHO_CHUNK_DELAY_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createConverseHandler(deps: { logger: Logger }) {
  return async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const req = validateBody(body);
    if (!req) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const log = deps.logger.child({ conversation_id: req.conversation_id });
    const lastUser = [...req.messages]
      .reverse()
      .find((m) => m.role === "user");
    const echo = lastUser?.content ?? "(no user message)";

    return streamSSE(c, async (stream) => {
      log.info({ message_count: req.messages.length }, "converse start (echo)");
      for (let i = 0; i < echo.length; i += ECHO_CHUNK_SIZE) {
        const delta = echo.slice(i, i + ECHO_CHUNK_SIZE);
        await stream.writeSSE({
          event: "text",
          data: JSON.stringify({ delta }),
        });
        if (i + ECHO_CHUNK_SIZE < echo.length) {
          await sleep(ECHO_CHUNK_DELAY_MS);
        }
      }
      await stream.writeSSE({ event: "done", data: "{}" });
      log.info("converse done (echo)");
    });
  };
}
