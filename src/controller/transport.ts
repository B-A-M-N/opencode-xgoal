/**
 * OpenCode-XGoal — real continuation transport over OpenCode 2's session API.
 *
 * `submit` uses the native session inbox (`POST /api/session/:id/synthetic`)
 * with a caller-supplied message ID. That ID is what makes retries idempotent:
 * the session can deduplicate a re-sent message, so a timeout never produces a
 * second continuation.
 *
 * `probe` answers "what actually happened to this round?" from observed events
 * rather than from our own hopes. Admission and execution are tracked as
 * separate facts, because the API only ever confirms the former.
 */
import type { ContinuationTransport, ProbeResult, SubmitResult } from "./driver.ts";
import type { GoalRound } from "./store.ts";

/** What we have observed about a given inbox message. */
interface Observed {
  enqueued: boolean;
  delivered: boolean;
  running: boolean;
  finished: boolean;
}

/**
 * Tracks continuation messages by inbox ID from the event stream.
 *
 * Events are wake-up signals, not the source of truth — the ledger is. This
 * tracker only sharpens the probe; a missing observation degrades to `unknown`,
 * which keeps the round outstanding rather than causing a duplicate send.
 */
export class RoundObserver {
  private readonly seen = new Map<string, Observed>();

  private slot(inboxID: string): Observed {
    let s = this.seen.get(inboxID);
    if (!s) {
      s = { enqueued: false, delivered: false, running: false, finished: false };
      this.seen.set(inboxID, s);
    }
    return s;
  }

  /** Feed one event. Unknown shapes are ignored rather than guessed at. */
  observe(event: unknown): void {
    const e = event as
      | {
          type?: string;
          data?: Record<string, unknown>;
          properties?: Record<string, unknown>;
        }
      | undefined;
    const type = e?.type;
    if (!type) return;
    // Event payloads put fields under `data` on session lifecycle events and
    // under `properties` on others; check both rather than assuming one.
    const d = e?.data ?? {};
    const p = e?.properties ?? {};
    const pick = (k: string): unknown => d[k] ?? p[k];

    // The message id appears under a few shapes depending on the event.
    const id =
      (pick("messageID") as string | undefined) ??
      (pick("messageId") as string | undefined) ??
      ((pick("message") as { id?: string } | undefined)?.id as string | undefined) ??
      ((pick("info") as { id?: string } | undefined)?.id as string | undefined);
    if (!id || !id.startsWith("msg_xgoal_")) return;

    const s = this.slot(id);
    switch (type) {
      case "session.inbox.enqueued":
        s.enqueued = true;
        break;
      case "session.inbox.delivered":
        s.enqueued = true;
        s.delivered = true;
        break;
      case "session.execution.started":
        s.delivered = true;
        s.running = true;
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
        s.finished = true;
        s.running = false;
        break;
      default:
        break;
    }
  }

  probe(inboxID: string): ProbeResult {
    const s = this.seen.get(inboxID);
    if (!s) return "unknown";
    if (s.finished) return "settled";
    if (s.running) return "running";
    // Enqueued or delivered but never observed to run: the message is sitting in
    // the inbox, so re-sending would duplicate it.
    if (s.enqueued || s.delivered) return "running";
    return "unknown";
  }

  /** Forget a round once it has settled, so the map cannot grow unbounded. */
  forget(inboxID: string): void {
    this.seen.delete(inboxID);
  }
}

export interface SessionTransportOptions {
  observer: RoundObserver;
  /** Invoke the native session inbox. Injected so this stays testable. */
  send: (input: {
    sessionID: string;
    inboxID: string;
    text: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * Distinguish "the request never got there" (safe to retry with the same id)
 * from "the request was rejected" (retrying will not help).
 */
function classify(error: unknown): SubmitResult {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number; statusCode?: number } | undefined);
  const code = status?.status ?? status?.statusCode;

  // Definitive client errors: the message will never be accepted as-is.
  if (typeof code === "number" && code >= 400 && code < 500 && code !== 408 && code !== 429) {
    return { ok: false, retryable: false, error: message };
  }
  // 404 on the session is definitive too — the session is gone.
  if (typeof code === "number" && code === 404) {
    return { ok: false, retryable: false, error: message };
  }
  // Everything else (timeout, 5xx, network, unknown) is ambiguous.
  return { ok: false, retryable: true, error: message };
}

export class SessionTransport implements ContinuationTransport {
  private readonly observer: RoundObserver;
  private readonly send: SessionTransportOptions["send"];

  constructor(options: SessionTransportOptions) {
    this.observer = options.observer;
    this.send = options.send;
  }

  async submit(input: {
    sessionID: string;
    inboxID: string;
    text: string;
    metadata: Record<string, unknown>;
  }): Promise<SubmitResult> {
    try {
      await this.send(input);
      return { ok: true };
    } catch (error) {
      return classify(error);
    }
  }

  async probe(input: { sessionID: string; round: GoalRound }): Promise<ProbeResult> {
    return this.observer.probe(input.round.inboxID);
  }
}
