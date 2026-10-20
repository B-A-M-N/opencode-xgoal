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
   * Token of the busy reference this slot holds in `runningBySession`, or
   * undefined. Releases are by token, so a reference can neither be released
   * twice nor spent on a different execution — even when the completion event
   * arrives without the message id that `started` carried.
   */
  counted?: number;
  sessionID?: string;
}

/** One held busy reference in a session's live set. */
interface BusyRef {
  startedMs: number;
  /** Inbox ID when the reference is tied to a continuation message slot. */
  slot?: string;
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
  /**
   * Live busy references per session: token → reference. The count is the
   * map size; the token is what makes releases safe — every release names
   * the exact reference it ends, so a completion event whose id-shape
   * differs from its `started` counterpart can never strand a slot flag or
   * spend another execution's reference.
   */
  private readonly runningBySession = new Map<string, Map<number, BusyRef>>();
  /** Per-session stack of held tokens, most recently started on top. */
  private readonly recentTokens = new Map<string, number[]>();
  private nextToken = 0;

  private slot(inboxID: string): Observed {
    let s = this.seen.get(inboxID);
    if (!s) {
      s = { enqueued: false, delivered: false, running: false, finished: false };
      this.seen.set(inboxID, s);
    }
    return s;
  }

  /** Hold one busy reference; returns its token. */
  private addBusy(sessionID: string, slot?: string): number {
    const token = ++this.nextToken;
    let refs = this.runningBySession.get(sessionID);
    if (!refs) {
      refs = new Map();
      this.runningBySession.set(sessionID, refs);
    }
    const ref: BusyRef = { startedMs: Date.now() };
    if (slot) ref.slot = slot;
    refs.set(token, ref);
    const stack = this.recentTokens.get(sessionID);
    if (stack) stack.push(token);
    else this.recentTokens.set(sessionID, [token]);
    return token;
  }

  /** Drop one reference by token. Already-released tokens are no-ops. */
  private release(sessionID: string, token: number): void {
    const refs = this.runningBySession.get(sessionID);
    if (!refs?.delete(token)) return;
    const stack = this.recentTokens.get(sessionID);
    if (stack) {
      const at = stack.indexOf(token);
      if (at >= 0) stack.splice(at, 1);
      if (stack.length === 0) this.recentTokens.delete(sessionID);
    }
    if (refs.size === 0) this.runningBySession.delete(sessionID);
  }

  /**
   * Release a specific token, clearing the owning slot's claim when it still
   * matches. This is the only path that releases a slot-tied reference, so a
   * released slot can never be released again by `forget`.
   */
  private releaseToken(sessionID: string, token: number): void {
    const ref = this.runningBySession.get(sessionID)?.get(token);
    if (!ref) return;
    if (ref.slot) {
      const slot = this.seen.get(ref.slot);
      if (slot?.counted === token) slot.counted = undefined;
    }
    this.release(sessionID, token);
  }

  /**
   * A completion event with no message identity. Executions in a session are
   * serialized, so the most recently started reference is the one that ended;
   * with true concurrency the live set is anonymous anyway, and token-guarded
   * releases keep mis-attribution harmless (no double release, no underflow).
   */
  private releaseMostRecent(sessionID: string): void {
    const stack = this.recentTokens.get(sessionID);
    const token = stack?.[stack.length - 1];
    if (token !== undefined) this.releaseToken(sessionID, token);
  }

  /**
   * A completion event naming a continuation whose `started` missed the id:
   * its reference was held directly. Release a direct reference — and only a
   * direct one, since another continuation's reference must not be spent on
   * an execution we cannot tie to it.
   */
  private releaseDirect(sessionID: string): void {
    const refs = this.runningBySession.get(sessionID);
    const stack = this.recentTokens.get(sessionID);
    if (!refs || !stack) return;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!refs.get(stack[i])?.slot) {
        this.releaseToken(sessionID, stack[i]);
        return;
      }
    }
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
    // real running execution, not infer one from silence. Every reference is
    // held under a unique token; a completion releases by token — its own
    // slot's when the id is known, otherwise the most recently started — so
    // id-shape mismatches between `started` and completion events cannot
    // double-release or release the wrong execution. Duplicate `started`
    // events are idempotent.
    if (type.startsWith("session.execution.")) {
      const sessionID = pick("sessionID") as string | undefined;
      if (sessionID) {
        const continuation = id?.startsWith("msg_xgoal_") ? this.slot(id) : undefined;
        const completed =
          type === "session.execution.succeeded" || type === "session.execution.failed";
        if (continuation) continuation.sessionID = sessionID;
        if (type === "session.execution.started") {
          if (continuation) {
            if (!continuation.counted) {
              continuation.counted = this.addBusy(sessionID, id);
            }
          } else {
            this.addBusy(sessionID);
          }
        } else if (completed) {
          if (continuation?.counted !== undefined) {
            this.releaseToken(sessionID, continuation.counted);
          } else if (continuation) {
            // The id is known but its slot never counted: the `started` event
            // missed the id and held a direct reference instead.
            this.releaseDirect(sessionID);
          } else {
            this.releaseMostRecent(sessionID);
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
    const refs = this.runningBySession.get(sessionID);
    if (!refs || refs.size === 0) return false;
    const now = Date.now();
    for (const ref of refs.values()) {
      if (now - ref.startedMs < LIVE_WAIT_TTL_MS) return true;
    }
    return false;
  }

  /**
   * Forget a round once it has settled, so the map cannot grow unbounded.
   *
   * Settlement is authoritative: the transcript showed the execution end. If
   * the completion event was missed, this is what releases the slot's busy
   * reference — event loss can no longer classify every future round as a
   * verified wait. The release is by token, so a slot whose reference was
   * already taken over by a shapeless completion cannot release again here.
   */
  forget(inboxID: string): void {
    const slot = this.seen.get(inboxID);
    if (slot?.counted !== undefined && slot.sessionID) {
      this.releaseToken(slot.sessionID, slot.counted);
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
