import { describe, expect, it } from "vitest";
import type { AcpFactory, AcpSession } from "../src/acp_session.js";
import {
  ConcurrentRequestError,
  PoolAtCapacityError,
  SessionPool,
} from "../src/session_pool.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("silent");

interface FakeHandle {
  session: AcpSession;
  signalExit: () => void;
}

function makeFakeSession(sessionId: string, onClose?: () => void): FakeHandle {
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  let closeCalled = false;
  const session: AcpSession = {
    sessionId,
    closed,
    async *prompt(_text: string): AsyncIterable<string> {
      yield "noop";
    },
    close(): Promise<void> {
      if (!closeCalled) {
        closeCalled = true;
        onClose?.();
        resolveClosed();
      }
      return Promise.resolve();
    },
  };
  return {
    session,
    signalExit: () => {
      resolveClosed();
    },
  };
}

function makeFactory(): {
  factory: AcpFactory;
  calls: number;
  handles: FakeHandle[];
} {
  const state = { calls: 0, handles: [] as FakeHandle[] };
  const factory: AcpFactory = () => {
    state.calls += 1;
    const h = makeFakeSession(`sess-${state.calls}`);
    state.handles.push(h);
    return Promise.resolve(h.session);
  };
  return {
    factory,
    get calls(): number {
      return state.calls;
    },
    get handles(): FakeHandle[] {
      return state.handles;
    },
  };
}

const baseOpts = { personaDir: "/tmp/p", oauthToken: "fake" };

describe("SessionPool — acquire / release", () => {
  it("reuses the same session for the same conversation_id", async () => {
    const f = makeFactory();
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const a = await pool.acquire("conv-1", baseOpts);
    expect(a.sessionId).toBe("sess-1");
    a.release();
    const b = await pool.acquire("conv-1", baseOpts);
    expect(b.sessionId).toBe("sess-1");
    expect(f.calls).toBe(1);
    b.release();
    await pool.close();
  });

  it("creates separate sessions for different conversation_ids", async () => {
    const f = makeFactory();
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const a = await pool.acquire("conv-A", baseOpts);
    const b = await pool.acquire("conv-B", baseOpts);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(f.calls).toBe(2);
    a.release();
    b.release();
    await pool.close();
  });

  it("rejects a concurrent request for the same conversation_id", async () => {
    const f = makeFactory();
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const a = await pool.acquire("conv-1", baseOpts);
    await expect(pool.acquire("conv-1", baseOpts)).rejects.toBeInstanceOf(
      ConcurrentRequestError,
    );
    a.release();
    await pool.close();
  });
});

describe("SessionPool — capacity", () => {
  it("evicts the oldest idle session when at capacity", async () => {
    const f = makeFactory();
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 2,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const a = await pool.acquire("conv-A", baseOpts);
    a.release();
    const b = await pool.acquire("conv-B", baseOpts);
    b.release();
    // Both idle; capacity reached. Acquiring a third should evict A (oldest).
    const c = await pool.acquire("conv-C", baseOpts);
    expect(f.calls).toBe(3);
    expect(pool.size()).toBe(2);
    c.release();
    // A should now be gone — re-acquiring it spawns a fresh session.
    const a2 = await pool.acquire("conv-A", baseOpts);
    expect(a2.sessionId).not.toBe("sess-1");
    a2.release();
    await pool.close();
  });

  it("rejects when at capacity and all sessions are in use", async () => {
    const f = makeFactory();
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 1,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const a = await pool.acquire("conv-A", baseOpts);
    await expect(pool.acquire("conv-B", baseOpts)).rejects.toBeInstanceOf(
      PoolAtCapacityError,
    );
    a.release();
    await pool.close();
  });
});

describe("SessionPool — idle TTL eviction", () => {
  it("closes entries idle past their TTL", async () => {
    const f = makeFactory();
    let now = 1_000_000;
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 1_000,
      idleCheckMs: 0,
      now: () => now,
    });
    const a = await pool.acquire("conv-A", baseOpts);
    a.release();
    // Still within TTL — should not evict.
    now += 500;
    expect(await pool.evictIdle()).toBe(0);
    expect(pool.size()).toBe(1);
    // Past TTL — should evict.
    now += 600;
    expect(await pool.evictIdle()).toBe(1);
    expect(pool.size()).toBe(0);
    await pool.close();
  });

  it("does not evict in-use entries even when they're old", async () => {
    const f = makeFactory();
    let now = 1_000_000;
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 1_000,
      idleCheckMs: 0,
      now: () => now,
    });
    const a = await pool.acquire("conv-A", baseOpts);
    // Don't release. Time passes far past the TTL.
    now += 10_000;
    expect(await pool.evictIdle()).toBe(0);
    expect(pool.size()).toBe(1);
    a.release();
    await pool.close();
  });
});

describe("SessionPool — subprocess exit handling", () => {
  it("purges a dead session and reopens on next acquire", async () => {
    const f = makeFactory();
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const a = await pool.acquire("conv-A", baseOpts);
    a.release();
    // Simulate subprocess death.
    f.handles[0]!.signalExit();
    // Let the .then handler run.
    await new Promise((r) => setTimeout(r, 5));
    expect(pool.size()).toBe(0);
    const a2 = await pool.acquire("conv-A", baseOpts);
    expect(a2.sessionId).toBe("sess-2");
    a2.release();
    await pool.close();
  });
});

describe("SessionPool — close()", () => {
  it("closes every pooled session", async () => {
    const f = makeFactory();
    const pool = new SessionPool({
      factory: f.factory,
      logger,
      maxConcurrent: 4,
      idleTtlMs: 60_000,
      idleCheckMs: 0,
    });
    const a = await pool.acquire("conv-A", baseOpts);
    const b = await pool.acquire("conv-B", baseOpts);
    a.release();
    b.release();
    await pool.close();
    // Subsequent acquire should fail.
    await expect(pool.acquire("conv-C", baseOpts)).rejects.toThrow(
      /shutting down/,
    );
  });
});
