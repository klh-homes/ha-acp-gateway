import type { AgentId } from "./agents/types.js";

export type SessionAffinity = "conversation" | "entity";

export interface Config {
  port: number;
  logLevel: string;
  bearerToken: string;
  personaDir: string;
  agent: AgentId;
  maxConcurrentSessions: number;
  sessionIdleTtlSec: number;
  /** Force-evict a session after this many seconds of total lifetime, even
   *  if it's been active. 0 disables max-age (idle TTL only). */
  sessionMaxAgeSec: number;
  /** "conversation" (default): pool keys on the request's conversation_id —
   *  HA's Assist controls reuse, fresh wake-words get cold sessions.
   *  "entity": pool collapses all requests to a single singleton session
   *  per service process — every request after the first hits the warm
   *  subprocess + agent's own prompt cache. Trade-off: the agent remembers
   *  prior unrelated conversations until the session is evicted. */
  sessionAffinity: SessionAffinity;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

function readRequired(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`${name} must be set`);
  }
  return v;
}

function readAffinity(): SessionAffinity {
  const raw = process.env.SESSION_AFFINITY;
  if (raw === undefined || raw === "") return "conversation";
  if (raw !== "conversation" && raw !== "entity") {
    throw new Error(
      `Invalid SESSION_AFFINITY: ${raw} (must be "conversation" or "entity")`,
    );
  }
  return raw;
}

function readAgent(): AgentId {
  const raw = process.env.ACP_AGENT;
  if (raw === undefined || raw === "") return "claude";
  if (raw !== "claude" && raw !== "codex") {
    throw new Error(
      `Invalid ACP_AGENT: ${raw} (must be "claude" or "codex")`,
    );
  }
  return raw;
}

export function loadConfig(): Config {
  return {
    port: readInt("PORT", 8765),
    logLevel: process.env.LOG_LEVEL ?? "info",
    bearerToken: readRequired("BEARER_TOKEN"),
    personaDir: readRequired("PERSONA_DIR"),
    agent: readAgent(),
    maxConcurrentSessions: readInt("MAX_CONCURRENT_SESSIONS", 8),
    sessionIdleTtlSec: readInt("SESSION_IDLE_TTL_SEC", 1800),
    sessionMaxAgeSec: readNonNegativeInt("SESSION_MAX_AGE_SEC", 0),
    sessionAffinity: readAffinity(),
  };
}
