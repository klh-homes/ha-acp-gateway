import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "./logger.js";
import type { SessionPool } from "./session_pool.js";
import {
  ConcurrentRequestError,
  PoolAtCapacityError,
} from "./session_pool.js";
import { chunkForTts } from "./tts_chunker.js";

export type { AcpFactory } from "./acp_session.js";

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

export interface ConverseHandlerDeps {
  logger: Logger;
  personaDir: string;
  oauthToken: string;
  pool: SessionPool;
}

function friendlyErrorMessage(err: unknown): string {
  if (err instanceof PoolAtCapacityError) {
    return "I'm busy with other requests right now. Please try again in a moment.";
  }
  if (err instanceof ConcurrentRequestError) {
    return "I'm still working on the previous request for this conversation.";
  }
  if (err instanceof Error && /subprocess exited/.test(err.message)) {
    return "I lost contact with the assistant. Please try again.";
  }
  // Anything else: log the real error (the caller already did) but do not
  // leak raw exception text to TTS. Voice users hearing "ENOENT" or
  // "ECONNREFUSED" is unhelpful.
  return "I had a problem completing that. Please try again.";
}

export function createConverseHandler(deps: ConverseHandlerDeps) {
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

    return streamSSE(c, async (stream) => {
      if (!lastUser) {
        log.warn("no user message in request");
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "No user message in request." }),
        });
        return;
      }

      let entry: Awaited<ReturnType<SessionPool["acquire"]>> | null = null;
      try {
        log.info(
          { message_count: req.messages.length },
          "acquiring ACP session from pool",
        );
        entry = await deps.pool.acquire(req.conversation_id, {
          personaDir: deps.personaDir,
          oauthToken: deps.oauthToken,
          logger: log,
        });
        log.info({ sessionId: entry.sessionId }, "converse stream start");

        for await (const chunk of chunkForTts(
          entry.session.prompt(lastUser.content),
        )) {
          await stream.writeSSE({
            event: "text",
            data: JSON.stringify({ delta: chunk }),
          });
        }
        await stream.writeSSE({ event: "done", data: "{}" });
        log.info("converse stream done");
      } catch (err) {
        log.error({ err }, "converse stream failed");
        const message = friendlyErrorMessage(err);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message }),
        });
      } finally {
        entry?.release();
      }
    });
  };
}
