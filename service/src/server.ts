import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import type { SessionAffinity } from "./config.js";
import { createConverseHandler } from "./converse.js";
import type { Logger } from "./logger.js";
import type { SessionPool } from "./session_pool.js";

export interface AppDeps {
  logger: Logger;
  bearerToken: string;
  personaDir: string;
  oauthToken: string;
  pool: SessionPool;
  sessionAffinity?: SessionAffinity;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.use("/v1/*", bearerAuth(deps.bearerToken));
  app.post(
    "/v1/converse",
    createConverseHandler({
      logger: deps.logger,
      personaDir: deps.personaDir,
      oauthToken: deps.oauthToken,
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
