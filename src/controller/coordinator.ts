/**
 * One authoritative path for goal lifecycle mutations.
 *
 * Creating, replacing or resuming a goal is not just a database write: it must
 * also cause the session to actually execute. The command handler, the TUI and
 * the RPC surface all go through this coordinator, so none of them can leave a
 * goal active-but-undriven.
 *
 * Pause is intentionally synchronous: it must stop work, not start it.
 */
import type { GoalController } from "./controller.ts";
import type { DriveOutcome } from "./driver.ts";
import type { Goal } from "./state.ts";

/** The part of the driver the coordinator needs. */
export interface GoalDispatcher {
  drive(sessionID: string): Promise<DriveOutcome>;
}

export interface StartResult {
  created?: Goal;
  existing?: Goal;
  drive?: DriveOutcome;
}

export interface MutationResult {
  goal: Goal;
  drive?: DriveOutcome;
}

export interface CoordinatorHooks {
  /** Called when scheduling execution throws, before the sweep retries. */
  onDriveError?: (sessionID: string, error: unknown) => void;
}

export class GoalCoordinator {
  private readonly controller: GoalController;
  private readonly dispatcher: () => GoalDispatcher | undefined;
  private readonly hooks: CoordinatorHooks;

  constructor(
    controller: GoalController,
    dispatcher: () => GoalDispatcher | undefined,
    hooks: CoordinatorHooks = {},
  ) {
    this.controller = controller;
    this.dispatcher = dispatcher;
    this.hooks = hooks;
  }

  /**
   * Create a goal and immediately schedule the first native execution.
   *
   * If a goal already exists this is a no-op that reports it, preserving the
   * explicit `/goal replace` contract rather than silently superseding work.
   */
  async start(sessionID: string, objective: string): Promise<StartResult> {
    const out = this.controller.startOrDescribe(sessionID, objective);
    if ("existing" in out) return { existing: out.existing };
    const drive = await this.drive(sessionID);
    return { created: out.created, drive };
  }

  /** Replace the current goal and schedule execution of the new generation. */
  async replace(
    sessionID: string,
    objective: string,
    expectedGeneration?: number,
  ): Promise<MutationResult> {
    const goal = this.controller.replace(sessionID, objective, expectedGeneration);
    const drive = await this.drive(sessionID);
    return { goal, drive };
  }

  /** Resume a paused/blocked goal and schedule the next execution. */
  async resume(sessionID: string): Promise<MutationResult> {
    const goal = this.controller.resume(sessionID);
    const drive = await this.drive(sessionID);
    return { goal, drive };
  }

  /** Pause stops dispatch; there is nothing to schedule. */
  pause(sessionID: string): Goal {
    return this.controller.pause(sessionID);
  }

  private async drive(sessionID: string): Promise<DriveOutcome | undefined> {
    const dispatcher = this.dispatcher();
    if (!dispatcher) return undefined;
    try {
      return await dispatcher.drive(sessionID);
    } catch (error) {
      // The mutation itself still stands and the sweep will retry the round, but
      // the failure must be visible rather than indistinguishable from "no
      // dispatcher". The plugin wires this hook to its structured log.
      this.hooks.onDriveError?.(sessionID, error);
      return undefined;
    }
  }
}
