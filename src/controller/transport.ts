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
  /**
   * Whether this execution currently holds a reference in `runningBySession`.
   * Tied to the slot so settlement can release it — a completion event that
   * never arrives cannot leak the reference forever.
   */
  counted?: boolean;
  sessionID?: string;
}

/**
 * A busy reference older than this is treated as stale.
 *
 * Safety net for the residue the slot bookkeeping cannot cover: an execution
 * whose completion event was dropped AND whose settlement is never observed in
 * any transcript. Prefer stalling a goal late (the user is asked) over letting
 * an unproductive session classify `verifiedWait` forever.
 */
const LIVE_WAIT_TTL_MS = 15 * 60 * 1000;

/**
 * Tracks continuation messages by inbox ID from the event stream.
 *
 * Events are wake-up signals, not the source of truth — the ledger is. This
 * tracker only sharpens the probe; a missing observation degrades to `unknown`,
 * which keeps the round outstanding rather than causing a duplicate send.
 */
export class RoundObserver {
  private readonly seen = new Map<string, Observed>();
  /** Running executions per session, from execution lifecycle events. */
  private readonly runningBySession = new Map<string, { count: number; touchedMs: number }>();

  private slot(inboxID: string): Observed {
    let s = this.seen.get(inboxID);
    if (!s) {
      s = { enqueued: false, delivered: false, running: false, finished: false };
      this.seen.set(inboxID, s);
    }
    return s;
  }

  private addBusy(sessionID: string): void {
    const now = Date.now();
    const entry = this.runningBySession.get(sessionID);
    if (entry) {
      entry.count += 1;
      entry.touchedMs = now;
    } else {
      this.runningBySession.set(sessionID, { count: 1, touchedMs: now });
    }
  }

  private removeBusy(sessionID: string): void {
    const entry = this.runningBySession.get(sessionID);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count <= 0) this.runningBySession.delete(sessionID);
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

    // Session-level execution liveness: a verified wait must be able to see a
    // real running execution, not infer one from silence. For our own
    // continuations the reference is tied to the message slot, so authoritative
    // settlement (which knows the slot) can release it even when the completion
    // event was never observed; duplicate `started` events are idempotent.
    if (type.startsWith("session.execution.")) {
      const sessionID = pick("sessionID") as string | undefined;
      if (sessionID) {
        const continuation = id?.startsWith("msg_xgoal_") ? this.slot(id) : undefined;
        if (continuation) {
          continuation.sessionID = sessionID;
          if (type === "session.execution.started") {
            if (!continuation.counted) {
              continuation.counted = true;
              this.addBusy(sessionID);
            }
          } else if (
            (type === "session.execution.succeeded" || type === "session.execution.failed") &&
            continuation.counted
          ) {
            continuation.counted = false;
            this.removeBusy(sessionID);
          }
        } else {
          const entry = this.runningBySession.get(sessionID);
          if (type === "session.execution.started") {
            this.addBusy(sessionID);
          } else if (
            (type === "session.execution.succeeded" || type === "session.execution.failed") &&
            entry
          ) {
            this.removeBusy(sessionID);
          }
        }
      }
    }

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

  /**
   * Is an execution for this session observably still running?
   *
   * A busy reference is released by its completion event OR by authoritative
   * transcript settlement of the round (see `forget`); a reference older than
   * the TTL is stale and ignored rather than pinning the session busy forever.
   */
  isBusy(sessionID: string): boolean {
    const entry = this.runningBySession.get(sessionID);
    if (!entry || entry.count <= 0) return false;
    return Date.now() - entry.touchedMs < LIVE_WAIT_TTL_MS;
  }

  /**
   * Forget a round once it has settled, so the map cannot grow unbounded.
   *
   * Settlement is authoritative: the transcript showed the execution end. If
   * the completion event was missed, this is what releases the slot's busy
   * reference — event loss can no longer classify every future round as a
   * verified wait.
   */
  forget(inboxID: string): void {
    const slot = this.seen.get(inboxID);
    if (slot?.counted && slot.sessionID) {
      slot.counted = false;
      this.removeBusy(slot.sessionID);
    }
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
  /**
   * Read authoritative session state. The event stream can miss events and the
   * in-memory observer dies with the process, so a round must be reconciled
   * against the session's own inbox and message history.
   */
  fetchState?: (input: { sessionID: string }) => Promise<SessionState>;
}

/** The minimal authoritative view a probe needs. */
export interface SessionState {
  inbox: Array<{ id: string }>;
  messages: Array<{
    id: string;
    type?: string;
    metadata?: Record<string, unknown>;
    time?: { created?: number };
    finish?: string;
  }>;
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
  private readonly fetchState: SessionTransportOptions["fetchState"];

  constructor(options: SessionTransportOptions) {
    this.observer = options.observer;
    this.send = options.send;
    this.fetchState = options.fetchState;
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

  /** Is an execution for this session observably still running? */
  liveWait(input: { sessionID: string }): boolean {
    return this.observer.isBusy(input.sessionID);
  }

  /**
   * Probe the authoritative session state, not just our own memory.
   *
   * The observer is a cache: it is fast and survives missed events, but it
   * starts empty after a restart and can miss an event entirely. If it cannot
   * prove settlement, the session's inbox and message history decide.
   */
  async probe(input: { sessionID: string; round: GoalRound }): Promise<ProbeResult> {
    const cached = this.observer.probe(input.round.inboxID);
    // A settled round is settled; no need to hit the session.
    if (cached === "settled") {
      this.observer.forget(input.round.inboxID);
      return "settled";
    }
    if (!this.fetchState) return cached;

    let state: SessionState;
    try {
      state = await this.fetchState({ sessionID: input.sessionID });
    } catch {
      // Authoritative read failed: fall back to the observer rather than
      // guessing, so the round stays outstanding and is retried.
      return cached;
    }

    const queued = state.inbox.some((item) => item.id === input.round.inboxID);
    const isOwn = (message: SessionState["messages"][number]): boolean =>
      message.id === input.round.inboxID ||
      message.metadata?.inboxID === input.round.inboxID ||
      message.metadata?.roundID === input.round.id;
    const index = state.messages.findIndex(isOwn);

    // Not in the transcript yet. If it is still in the inbox it is queued;
    // otherwise the outcome is genuinely unknown, which keeps it outstanding.
    if (index === -1) {
      if (queued) return "running";
      return cached === "unknown" ? "unknown" : cached;
    }

    // Delivered. Scan FORWARD from the round message for evidence the turn
    // ended: the session went idle, or an assistant message reached a terminal
    // finish. `tool-calls` is not a finish: the loop continues with more tool
    // work.
    //
    // The scan is bounded by the first foreign user message. A human prompt
    // interleaved after our continuation starts a NEW turn: everything after
    // it belongs to that turn, so a terminal assistant answering the human
    // must not be scored as settlement of our round. If the foreign prompt
    // comes first, the round's fate is genuinely unknown — never "settled".
    for (let i = index + 1; i < state.messages.length; i++) {
      const message = state.messages[i];
      const foreign =
        message.type === "user" &&
        message.id !== input.round.inboxID &&
        !isOwn(message);
      if (foreign) {
        return cached === "running" ? "running" : "unknown";
      }
      if (message.type === "idle") {
        this.observer.forget(input.round.inboxID);
        return "settled";
      }
      if (
        message.type === "assistant" &&
        (message.finish === "stop" ||
          message.finish === "length" ||
          message.finish === "content-filter" ||
          message.finish === "error")
      ) {
        this.observer.forget(input.round.inboxID);
        return "settled";
      }
    }
    // No terminal signal and no foreign prompt: the turn may still be running.
    return "running";
  }
}
