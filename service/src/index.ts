import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createApp } from "./server.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = createApp({
  logger,
  bearerToken: config.bearerToken,
  personaDir: config.personaDir,
  oauthToken: config.oauthToken,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, "service listening");
});

function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
