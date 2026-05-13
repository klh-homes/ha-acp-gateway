import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { openAcpSession } from "./acp_session.js";
import type { AcpSession } from "./acp_session.js";
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

export type AcpFactory = (opts: {
  personaDir: string;
  oauthToken: string;
  logger: Logger;
}) => Promise<AcpSession>;

const defaultAcpFactory: AcpFactory = (opts) => openAcpSession(opts);

export interface ConverseHandlerDeps {
  logger: Logger;
  personaDir: string;
  oauthToken: string;
  /** Test-injection point. Defaults to spawning a real claude-agent-acp. */
  acpFactory?: AcpFactory;
}

export function createConverseHandler(deps: ConverseHandlerDeps) {
  const acpFactory = deps.acpFactory ?? defaultAcpFactory;

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

      let session: AcpSession | null = null;
      try {
        log.info(
          { message_count: req.messages.length },
          "opening ACP session",
        );
        session = await acpFactory({
          personaDir: deps.personaDir,
          oauthToken: deps.oauthToken,
          logger: log,
        });
        log.info({ sessionId: session.sessionId }, "converse stream start");

        for await (const delta of session.prompt(lastUser.content)) {
          await stream.writeSSE({
            event: "text",
            data: JSON.stringify({ delta }),
          });
        }
        await stream.writeSSE({ event: "done", data: "{}" });
        log.info("converse stream done");
      } catch (err) {
        log.error({ err }, "converse stream failed");
        const message =
          err instanceof Error
            ? err.message
            : "The assistant could not complete the request.";
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message }),
        });
      } finally {
        if (session) {
          try {
            await session.close();
          } catch (err) {
            log.warn({ err }, "session close failed");
          }
        }
      }
    });
  };
}
