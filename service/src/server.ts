import { Hono } from "hono";
import type { AgentLauncher } from "./agents/types.js";
import { bearerAuth } from "./auth.js";
import type { SessionAffinity } from "./config.js";
import { createConverseHandler } from "./converse.js";
import type { Logger } from "./logger.js";
import type { SessionPool } from "./session_pool.js";

export interface AppDeps {
  logger: Logger;
  bearerToken: string;
  personaDir: string;
  launcher: AgentLauncher;
  pool: SessionPool;
  sessionAffinity?: SessionAffinity;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({ status: "ok", agent: deps.launcher.id });
  });

  app.use("/v1/*", bearerAuth(deps.bearerToken));
  app.post(
    "/v1/converse",
    createConverseHandler({
      logger: deps.logger,
      personaDir: deps.personaDir,
      launcher: deps.launcher,
      pool: deps.pool,
      ...(deps.sessionAffinity ? { sessionAffinity: deps.sessionAffinity } : {}),
    }),
  );

  app.onError((err, c) => {
    deps.logger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
