import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { createLogger } from "../src/logger.js";

describe("GET /healthz", () => {
  const app = createApp({ logger: createLogger("silent") });

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
