import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export function bearerAuth(expectedToken: string): MiddlewareHandler {
  if (!expectedToken) {
    throw new Error("bearerAuth requires a non-empty token");
  }
  const expected = Buffer.from(expectedToken, "utf8");

  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
