import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";
import { SessionPool } from "../src/session_pool.js";

const logger = createLogger("silent");

function makeAppForHealthz() {
  return createApp({
    logger,
    bearerToken: "unused-for-healthz",
    personaDir: "/tmp/unused",
    oauthToken: "unused",
    pool: new SessionPool({
      factory: () =>
        Promise.reject(new Error("factory should not be called for /healthz")),
      logger,
      maxConcurrent: 1,
      idleTtlMs: 0,
      idleCheckMs: 0,
    }),
  });
}

describe("GET /healthz", () => {
  const app = makeAppForHealthz();

  it("returns 200 with status ok", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("does not require authentication", async () => {
    const res = await app.request("/healthz", {
      headers: { authorization: "" },
    });
    expect(res.status).toBe(200);
  });
});
