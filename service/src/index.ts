import { serve } from "@hono/node-server";
import { openAcpSession } from "./acp_session.js";
import { createLauncher } from "./agents/index.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createApp } from "./server.js";
import { SessionPool } from "./session_pool.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const launcher = createLauncher(config.agent);

const pool = new SessionPool({
  factory: (opts) => openAcpSession(opts),
  logger,
  maxConcurrent: config.maxConcurrentSessions,
  idleTtlMs: config.sessionIdleTtlSec * 1000,
  idleCheckMs: 60_000,
  maxAgeMs: config.sessionMaxAgeSec * 1000,
});

const app = createApp({
  logger,
  bearerToken: config.bearerToken,
  personaDir: config.personaDir,
  launcher,
  pool,
  sessionAffinity: config.sessionAffinity,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    {
      port: info.port,
      agent: launcher.id,
      session_affinity: config.sessionAffinity,
      idle_ttl_sec: config.sessionIdleTtlSec,
      max_age_sec: config.sessionMaxAgeSec,
    },
    "service listening",
  );
});

function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, "shutting down");
  void pool.close().finally(() => {
    server.close(() => {
      process.exit(0);
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
