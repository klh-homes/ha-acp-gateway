import { Hono } from "hono";
import type { Logger } from "./logger.js";

export interface AppDeps {
  logger: Logger;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  app.onError((err, c) => {
    deps.logger.error({ err }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
