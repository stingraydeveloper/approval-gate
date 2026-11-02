import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";

export type Status = "pending" | "approved" | "rejected" | "claimed";

export interface DraftInput {
  idempotencyKey: string;
  channel: string;
  recipient: string;
  subject?: string;
  body: string;
  reason: string;
}

export interface Approval extends DraftInput {
  id: string;
  status: Status;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  /** What the person approved. Differs from `body` when they edited the draft. */
  finalBody?: string;
  claimedAt?: string;
}

type EventBody =
  | { type: "requested"; id: string; draft: DraftInput }
  | { type: "approved"; id: string; by: string; finalBody: string; note?: string }
  | { type: "rejected"; id: string; by: string; note?: string }
  | { type: "claimed"; id: string };

type StoredEvent = EventBody & { at: string; prev: string; hash: string };

export class GateError extends Error {}

const GENESIS = "0".repeat(64);
const LOCK_WAIT_MS = 2000;

function hashOf(prev: string, at: string, body: EventBody): string {
  return createHash("sha256").update(prev).update(at).update(JSON.stringify(body)).digest("hex");
}

/**
 * Approvals stored as an append-only, hash-chained JSONL log.
 *
 * The agent's MCP process and the person's review process share this file, so
 * every write takes a lock file, replays the log, then appends one event.
 */
export class Gate {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  request(draft: DraftInput): { approval: Approval; duplicate: boolean } {
    if (!draft.idempotencyKey.trim()) throw new GateError("idempotencyKey is required");
    if (!draft.body.trim()) throw new GateError("body is empty");
    return this.withLock(() => {
      const state = this.replay();
      const existing = [...state.values()].find((a) => a.idempotencyKey === draft.idempotencyKey);
      if (existing) {
        if (existing.body !== draft.body || existing.recipient !== draft.recipient) {
          throw new GateError(
            `idempotency key "${draft.idempotencyKey}" was already used for a different draft (${existing.id})`,
          );
        }
        return { approval: existing, duplicate: true };
      }
      const id = `apr_${randomBytes(6).toString("hex")}`;
      this.append({ type: "requested", id, draft });
      return { approval: this.mustGet(id), duplicate: false };
    });
  }

  get(id: string): Approval | undefined {
    return this.replay().get(id);
  }

  list(status?: Status): Approval[] {
    const all = [...this.replay().values()];
    return status ? all.filter((a) => a.status === status) : all;
  }

  approve(id: string, by: string, opts: { editedBody?: string; note?: string } = {}): Approval {
    return this.withLock(() => {
      const current = this.requireStatus(id, "pending");
      const finalBody = opts.editedBody ?? current.body;
      if (!finalBody.trim()) throw new GateError("approved body is empty");
      this.append({ type: "approved", id, by, finalBody, ...(opts.note ? { note: opts.note } : {}) });
      return this.mustGet(id);
    });
  }

  reject(id: string, by: string, note?: string): Approval {
    return this.withLock(() => {
      this.requireStatus(id, "pending");
      this.append({ type: "rejected", id, by, ...(note ? { note } : {}) });
      return this.mustGet(id);
    });
  }

  /** Hands the approved text to the sender exactly once. */
  claim(id: string): Approval {
    return this.withLock(() => {
      this.requireStatus(id, "approved");
      this.append({ type: "claimed", id });
      return this.mustGet(id);
    });
  }

  /** Walks the hash chain. Returns the line of the first broken event, if any. */
  verify(): { ok: true; events: number } | { ok: false; brokenAtLine: number } {
    let prev = GENESIS;
    const events = this.readEvents();
    for (const [i, event] of events.entries()) {
      const { at, prev: storedPrev, hash, ...body } = event;
      if (storedPrev !== prev || hash !== hashOf(prev, at, body as EventBody)) {
        return { ok: false, brokenAtLine: i + 1 };
      }
      prev = hash;
    }
    return { ok: true, events: events.length };
  }

  private requireStatus(id: string, expected: Status): Approval {
    const approval = this.replay().get(id);
    if (!approval) throw new GateError(`no approval with id ${id}`);
    if (approval.status !== expected) {
      throw new GateError(`${id} is ${approval.status}, expected ${expected}`);
    }
    return approval;
  }

  private mustGet(id: string): Approval {
    const approval = this.replay().get(id);
    if (!approval) throw new GateError(`no approval with id ${id}`);
    return approval;
  }

  private readEvents(): StoredEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent);
  }

  private replay(): Map<string, Approval> {
    const state = new Map<string, Approval>();
    for (const event of this.readEvents()) {
      if (event.type === "requested") {
        state.set(event.id, { ...event.draft, id: event.id, status: "pending", requestedAt: event.at });
        continue;
      }
      const approval = state.get(event.id);
      if (!approval) continue;
      if (event.type === "approved") {
        Object.assign(approval, {
          status: "approved",
          decidedAt: event.at,
          decidedBy: event.by,
          finalBody: event.finalBody,
          note: event.note,
        });
      } else if (event.type === "rejected") {
        Object.assign(approval, { status: "rejected", decidedAt: event.at, decidedBy: event.by, note: event.note });
      } else {
        Object.assign(approval, { status: "claimed", claimedAt: event.at });
      }
    }
    return state;
  }

  private append(body: EventBody): void {
    const prev = this.readEvents().at(-1)?.hash ?? GENESIS;
    const at = this.now().toISOString();
    const stored = { ...body, at, prev, hash: hashOf(prev, at, body) };
    appendFileSync(this.path, JSON.stringify(stored) + "\n", { flag: "a" });
  }

  private withLock<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    const started = Date.now();
    for (;;) {
      try {
        closeSync(openSync(lock, "wx"));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() - started > LOCK_WAIT_MS) {
          throw new GateError(`could not lock ${lock}; if nothing else is running, delete that file`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      unlinkSync(lock);
    }
  }
}
