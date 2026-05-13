import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";

const app = createApp({
  logger: createLogger("silent"),
  bearerToken: "unused-for-healthz",
});

describe("GET /healthz", () => {
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
