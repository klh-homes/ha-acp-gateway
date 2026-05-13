import type { AcpFactory, AcpSession } from "./acp_session.js";
import type { Logger } from "./logger.js";

export interface PoolEntry {
  readonly sessionId: string;
  readonly session: AcpSession;
  /** Mark the entry as free for reuse. Idempotent. */
  release(): void;
}

export interface SessionPoolOptions {
  factory: AcpFactory;
  logger: Logger;
  /** Hard cap on simultaneous spawned sessions. */
  maxConcurrent: number;
  /** Milliseconds an idle entry may live before background eviction. */
  idleTtlMs: number;
  /** How often the background sweeper runs. 0 disables it. */
  idleCheckMs: number;
  /** Force-evict on the next acquire after an entry exceeds this lifetime
   *  in ms. 0 disables (idle TTL is then the only eviction trigger). */
  maxAgeMs?: number;
  /** Override clock for tests. */
  now?: () => number;
}

export interface AcquireOptions {
  personaDir: string;
  oauthToken: string;
  logger?: Logger;
}

interface InternalEntry {
  conversationId: string;
  session: AcpSession;
  inUse: boolean;
  exited: boolean;
  lastUsedAt: number;
  createdAt: number;
}

export class PoolAtCapacityError extends Error {
  constructor() {
    super("session pool at capacity (all in use)");
    this.name = "PoolAtCapacityError";
  }
}

export class ConcurrentRequestError extends Error {
  constructor(conversationId: string) {
    super(
      `conversation ${conversationId} already has an in-flight request`,
    );
    this.name = "ConcurrentRequestError";
  }
}

export class SessionPool {
  private entries = new Map<string, InternalEntry>();
  private readonly factory: AcpFactory;
  private readonly logger: Logger;
  private readonly maxConcurrent: number;
  private readonly idleTtlMs: number;
  private readonly maxAgeMs: number;
  private readonly clock: () => number;
  private readonly sweeper: NodeJS.Timeout | null;
  private shuttingDown = false;

  constructor(opts: SessionPoolOptions) {
    this.factory = opts.factory;
    this.logger = opts.logger;
    this.maxConcurrent = opts.maxConcurrent;
    this.idleTtlMs = opts.idleTtlMs;
    this.maxAgeMs = opts.maxAgeMs ?? 0;
    this.clock = opts.now ?? (() => Date.now());

    if (opts.idleCheckMs > 0) {
      this.sweeper = setInterval(() => {
        void this.evictIdle();
      }, opts.idleCheckMs);
      // Don't keep the event loop alive just for the sweeper.
      this.sweeper.unref();
    } else {
      this.sweeper = null;
    }
  }

  async acquire(
    conversationId: string,
    opts: AcquireOptions,
  ): Promise<PoolEntry> {
    if (this.shuttingDown) {
      throw new Error("session pool is shutting down");
    }

    const existing = this.entries.get(conversationId);
    if (existing && !existing.exited) {
      if (existing.inUse) {
        throw new ConcurrentRequestError(conversationId);
      }
      // Force-evict if the entry has lived past its max age. Only checked
      // on idle acquire — we don't yank a session out from under an
      // in-flight request.
      if (
        this.maxAgeMs > 0 &&
        this.clock() - existing.createdAt >= this.maxAgeMs
      ) {
        this.logger.info(
          { conversationId, reason: "max-age" },
          "evicting session past max age",
        );
        this.entries.delete(conversationId);
        await this.safeClose(existing);
      } else {
        existing.inUse = true;
        existing.lastUsedAt = this.clock();
        return this.wrapEntry(existing);
      }
    }
    if (existing?.exited) {
      this.entries.delete(conversationId);
    }

    if (this.entries.size >= this.maxConcurrent) {
      const victim = this.findEvictionVictim();
      if (!victim) {
        throw new PoolAtCapacityError();
      }
      this.logger.info(
        { conversationId: victim.conversationId, reason: "capacity" },
        "evicting idle session",
      );
      this.entries.delete(victim.conversationId);
      await this.safeClose(victim);
    }

    const sessionLogger = opts.logger ?? this.logger;
    const session = await this.factory({
      personaDir: opts.personaDir,
      oauthToken: opts.oauthToken,
      logger: sessionLogger,
    });

    const now = this.clock();
    const entry: InternalEntry = {
      conversationId,
      session,
      inUse: true,
      exited: false,
      lastUsedAt: now,
      createdAt: now,
    };
    this.entries.set(conversationId, entry);

    void session.closed.then(() => {
      entry.exited = true;
      if (!entry.inUse) {
        this.entries.delete(conversationId);
      }
    });

    return this.wrapEntry(entry);
  }

  /**
   * Evict all entries whose idle time exceeds `idleTtlMs`. Returns the
   * number of sessions actually closed.
   */
  async evictIdle(now: number = this.clock()): Promise<number> {
    if (this.shuttingDown) return 0;
    const victims: InternalEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.inUse) continue;
      if (now - entry.lastUsedAt < this.idleTtlMs) continue;
      victims.push(entry);
    }
    for (const v of victims) {
      this.entries.delete(v.conversationId);
      this.logger.info(
        { conversationId: v.conversationId, reason: "idle" },
        "evicting idle session",
      );
      await this.safeClose(v);
    }
    return victims.length;
  }

  /**
   * Number of pooled entries (in use or idle, excluding exited).
   */
  size(): number {
    let n = 0;
    for (const e of this.entries.values()) if (!e.exited) n++;
    return n;
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(all.map((e) => this.safeClose(e)));
  }

  private findEvictionVictim(): InternalEntry | undefined {
    let oldest: InternalEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.inUse) continue;
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
        oldest = entry;
      }
    }
    return oldest;
  }

  private wrapEntry(entry: InternalEntry): PoolEntry {
    let released = false;
    return {
      sessionId: entry.session.sessionId,
      session: entry.session,
      release: () => {
        if (released) return;
        released = true;
        entry.inUse = false;
        entry.lastUsedAt = this.clock();
        // If the underlying subprocess already died, drop the entry now.
        if (entry.exited) {
          this.entries.delete(entry.conversationId);
        }
      },
    };
  }

  private async safeClose(entry: InternalEntry): Promise<void> {
    try {
      await entry.session.close();
    } catch (err) {
      this.logger.warn(
        { err, conversationId: entry.conversationId },
        "session close failed during pool eviction",
      );
    }
  }
}
