import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentLauncher } from "./agents/types.js";
import type { SessionAffinity } from "./config.js";
import type { Logger } from "./logger.js";
import type { SessionPool } from "./session_pool.js";
import {
  ConcurrentRequestError,
  PoolAtCapacityError,
} from "./session_pool.js";
import { chunkForTts } from "./tts_chunker.js";

export type { AcpFactory } from "./acp_session.js";

/** Pool key used when SESSION_AFFINITY=entity collapses all requests to a
 *  single shared session per service process. The literal value isn't
 *  visible to clients; it just needs to be deterministic and distinct
 *  from any conversation_id a client would send. */
const SINGLETON_POOL_KEY = "__singleton__";

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
  launcher: AgentLauncher;
  pool: SessionPool;
  /** Default "conversation" — pool keys on each request's conversation_id.
   *  "entity" collapses every request to one singleton session, trading
   *  cross-conversation memory bleed for permanent warm-cache hits. */
  sessionAffinity?: SessionAffinity;
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
  const affinity = deps.sessionAffinity ?? "conversation";

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
        const poolKey =
          affinity === "entity" ? SINGLETON_POOL_KEY : req.conversation_id;
        log.info(
          { message_count: req.messages.length, affinity, pool_key: poolKey },
          "acquiring ACP session from pool",
        );
        entry = await deps.pool.acquire(poolKey, {
          personaDir: deps.personaDir,
          launcher: deps.launcher,
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
