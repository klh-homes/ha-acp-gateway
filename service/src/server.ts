import { Hono } from "hono";
import { bearerAuth } from "./auth.js";
import { createConverseHandler } from "./converse.js";
import type { Logger } from "./logger.js";

export interface AppDeps {
  logger: Logger;
  bearerToken: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.use("/v1/*", bearerAuth(deps.bearerToken));
  app.post("/v1/converse", createConverseHandler({ logger: deps.logger }));

  app.onError((err, c) => {
    deps.logger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
