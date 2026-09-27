import { randomUUID } from 'node:crypto';
import { LoopError, isLoopError, toLoopError, type ErrorCode } from '../core/errors';
import type { Clock, Logger } from '../core/ports';
import type { GateResult } from '../gates/gate-types';
import type { IterationRecord, LoopRecord, LoopState } from '../persistence/models';
import { RECORD_SCHEMA_VERSION } from '../persistence/models';
import type { RunLock, StateStore } from '../persistence/state-store';
import type { LoadedTask } from '../tasks/task-loader';
import { initialCriteria } from './completion';
import { PHASES, type HistoryPart, type PhaseDependencies, type StepOutcome } from './phases';
import { isActive, isTerminal, transition } from './state-machine';

export interface LoopEvents {
  onRecord?: (record: LoopRecord) => void;
}

export interface ControllerDependencies extends PhaseDependencies {
  store: StateStore;
  lock?: RunLock;
  /** Returns false when the workspace folder has disappeared. */
  workspaceAvailable: () => Promise<boolean>;
  events?: LoopEvents;
}

/**
 * The controller. It owns the state machine, persistence, limits, cancellation
 * and completion; agents only ever run inside a phase handler. It never
 * decides completion from model output alone.
 */
export class LoopController {
  private record: LoopRecord | undefined;
  private running: Promise<LoopRecord> | undefined;
  private abort: AbortController | undefined;
  private pauseRequested = false;
  private stopRequested = false;
  /** Set synchronously while a command prepares a run, closing the gap before `running` is assigned. */
  private busy = false;

  constructor(private readonly deps: ControllerDependencies) {}

  get current(): LoopRecord | undefined {
    return this.record ? structuredClone(this.record) : undefined;
  }

  get isRunning(): boolean {
    return this.running !== undefined || this.busy;
  }

  /** Runs `prepare` exclusively, then starts the loop without yielding in between. */
  private async exclusive(prepare: () => Promise<void>): Promise<LoopRecord> {
    this.assertIdle();
    this.busy = true;
    try {
      await prepare();
    } finally {
      this.busy = false;
    }
    return this.run();
  }

  private get clock(): Clock { return this.deps.clock; }
  private get logger(): Logger { return this.deps.logger; }

  /** Loads persisted state. A run that was active when VS Code closed is recovered as PAUSED. */
  async load(): Promise<LoopRecord | undefined> {
    const record = await this.deps.store.load();
    this.record = record;
    if (record && isActive(record.state) && !this.running) {
      this.logger.warn(`Recovered an interrupted run in state ${record.state}; it is now PAUSED. Use Resume to continue.`);
      await this.commit(transition(record, 'PAUSED', 'recovered after interruption (restart or crash)', this.clock));
    }
    return this.current;
  }

  /** Creates a new run for a task. Refuses while a non-terminal run exists unless `replace` is set. */
  start(loaded: LoadedTask, options: { replace?: boolean } = {}): Promise<LoopRecord> {
    return this.exclusive(async () => {
    const existing = this.record ?? (await this.deps.store.load());
    if (existing && !isTerminal(existing.state) && !options.replace) {
      throw new LoopError('CONFIGURATION_ERROR', `A run for task ${existing.task.id} is ${existing.state}. Stop it first or confirm replacing it.`);
    }
    if (existing) await this.deps.store.archiveCurrent();
    const now = this.clock.now().toISOString();
    const record: LoopRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      runId: randomUUID(),
      task: loaded.task,
      taskPath: loaded.path,
      taskHash: loaded.hash,
      state: 'INTAKE',
      iteration: 0,
      agentRuns: 0,
      iterationBase: 0,
      agentRunBase: 0,
      reviewRejections: 0,
      unstableReviews: 0,
      escalation: 0,
      historySequence: 0,
      criteria: initialCriteria(loaded.task),
      requirements: loaded.task.requirements.map((r) => ({ name: r.name, gates: r.gates, satisfied: false, unmet: ['not validated yet'] })),
      lastGateResults: [],
      lastFailures: [],
      controllerDiagnostics: [],
      pending: [],
      lastFixAgents: [],
      fingerprints: {},
      progress: [],
      changedFiles: [],
      recentAgents: [],
      checkpoints: [],
      transitions: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.commit(record);
    this.logger.info(`Task ${loaded.task.id} started (run ${record.runId})`);
    });
  }

  /** Drives the loop until it reaches an idle state (DONE, BLOCKED, PAUSED, STOPPED). */
  run(): Promise<LoopRecord> {
    if (this.running) return this.running;
    const record = this.record;
    if (!record) return Promise.reject(new LoopError('CONFIGURATION_ERROR', 'No task has been started'));
    this.pauseRequested = false;
    this.stopRequested = false;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.running = this.loop(signal).finally(() => {
      this.running = undefined;
      this.abort = undefined;
    });
    return this.running;
  }

  /** Graceful pause: the current step finishes, then the loop stops in PAUSED. */
  async pause(): Promise<LoopRecord | undefined> {
    this.assertNotBusy();
    if (this.running) {
      this.pauseRequested = true;
      this.logger.info('Pause requested; the loop will pause after the current step');
      return this.running;
    }
    if (this.record && isActive(this.record.state)) {
      await this.commit(transition(this.record, 'PAUSED', 'paused by user', this.clock));
    }
    return this.current;
  }

  resume(): Promise<LoopRecord> {
    return this.exclusive(async () => {
      const record = this.requireRecord();
      if (record.state !== 'PAUSED' || !record.pausedFrom) {
        throw new LoopError('CONFIGURATION_ERROR', `Cannot resume from ${record.state}`);
      }
      await this.commit(transition(record, record.pausedFrom, 'resumed by user', this.clock));
    });
  }

  /**
   * Immediate pause (used when VS Code shuts down): cancels in-flight model
   * requests and gate processes and pauses. The interrupted step re-runs on
   * resume; an already-claimed iteration is not consumed twice.
   */
  async interrupt(): Promise<LoopRecord | undefined> {
    if (this.running) {
      this.pauseRequested = true;
      this.abort?.abort();
      return this.running;
    }
    return this.current;
  }

  /** Stops immediately: cancels in-flight model requests and gate processes. */
  async stop(): Promise<LoopRecord | undefined> {
    this.assertNotBusy();
    if (this.running) {
      this.stopRequested = true;
      this.abort?.abort();
      return this.running;
    }
    if (this.record && !isTerminal(this.record.state)) {
      await this.commit(transition(this.record, 'STOPPED', 'stopped by user', this.clock));
    }
    return this.current;
  }

  /**
   * Human retry after BLOCKED: resets repetition/no-progress tracking and grants
   * a fresh iteration budget. Every retry is an explicit human decision.
   */
  retry(): Promise<LoopRecord> {
    return this.exclusive(async () => {
    const record = this.requireRecord();
    if (record.state !== 'BLOCKED') throw new LoopError('CONFIGURATION_ERROR', `Retry is only available when BLOCKED (current: ${record.state})`);
    const target: LoopState = record.plan ? 'VALIDATE' : 'INTAKE';
    const fingerprints = Object.fromEntries(Object.entries(record.fingerprints).map(([k, v]) => [k, { ...v, consecutive: 0 }]));
    const reset: LoopRecord = { ...record, fingerprints, progress: [], escalation: 0, reviewRejections: 0, unstableReviews: 0, iterationBase: record.iteration, agentRunBase: record.agentRuns, pending: [] };
    delete reset.claimedIteration;
    await this.commit(transition(reset, target, `retry by user after ${record.blocked?.code ?? 'block'}`, this.clock));
    });
  }

  /** Runs the task's gates once, outside the loop. Does not change loop state. */
  validateOnly(gateIds: readonly string[], signal?: AbortSignal): Promise<GateResult[]> {
    this.assertIdle();
    this.busy = true;
    return this.deps.gates.runAll(gateIds, { workspaceRoot: this.deps.workspaceRoot, ...(signal ? { signal } : {}) }).finally(() => {
      this.busy = false;
    });
  }

  private assertIdle(): void {
    if (this.running || this.busy) throw new LoopError('CONFIGURATION_ERROR', 'The loop is currently running');
  }

  private assertNotBusy(): void {
    if (this.busy) throw new LoopError('CONFIGURATION_ERROR', 'A command is being prepared; try again in a moment');
  }

  private requireRecord(): LoopRecord {
    if (!this.record) throw new LoopError('CONFIGURATION_ERROR', 'No task has been started in this workspace');
    return this.record;
  }

  private async commit(record: LoopRecord): Promise<void> {
    this.record = record;
    await this.deps.store.save(record);
    this.deps.events?.onRecord?.(structuredClone(record));
  }

  private async writeHistory(before: LoopRecord, after: LoopRecord, parts: HistoryPart[], startedAt: string, reason: string): Promise<LoopRecord> {
    let sequence = after.historySequence;
    const result: IterationRecord['result'] = after.state === 'DONE' ? 'done' : after.state === 'BLOCKED' ? 'blocked' : after.state === 'PAUSED' ? 'paused' : after.state === 'STOPPED' ? 'stopped' : 'continue';
    for (const part of parts.length ? parts : [{ notes: [] }]) {
      sequence++;
      const entry: IterationRecord = {
        task: after.task.id,
        runId: after.runId,
        sequence,
        iteration: after.iteration,
        phase: before.state,
        ...(part.agent ? { agent: part.agent } : {}),
        ...(part.model ? { model: part.model } : {}),
        startedAt: part.agentRun?.startedAt ?? startedAt,
        finishedAt: part.agentRun?.finishedAt ?? this.clock.now().toISOString(),
        changedFiles: part.agentRun?.changedFiles ?? after.changedFiles,
        gates: part.gates ?? [],
        diagnostics: part.diagnostics ?? [],
        ...(part.agentRun ? { agentRun: part.agentRun } : {}),
        ...(part.transcript ? { transcript: part.transcript } : {}),
        ...(part.gateOutput ? { gateOutput: part.gateOutput } : {}),
        notes: [...part.notes, reason],
        result,
        nextState: after.state,
      };
      try {
        await this.deps.store.appendHistory(entry);
      } catch (error) {
        this.logger.error('Failed to write history entry', { sequence, error: String(error) });
      }
    }
    return { ...after, historySequence: sequence };
  }

  private blockedOutcome(record: LoopRecord, error: LoopError): StepOutcome {
    return { record, next: 'BLOCKED', reason: error.message, blocked: error.toJSON(), history: [{ notes: [`${error.code}: ${error.message}`] }] };
  }

  private async loop(signal: AbortSignal): Promise<LoopRecord> {
    if (this.deps.lock) {
      try {
        await this.deps.lock.acquire(`task ${this.record?.task.id ?? ''}`);
      } catch (error) {
        const e = toLoopError(error, 'WORKSPACE_ERROR');
        this.logger.error(e.message);
        throw e;
      }
    }
    try {
      // Hard guard against any controller bug causing endless state ping-pong.
      const limits = this.requireRecord().task.limits;
      const maxSteps = limits.maxIterations * 6 + limits.maxAgentRuns + 50;
      let steps = 0;
      for (;;) {
        const record = this.requireRecord();
        if (!isActive(record.state)) return this.current as LoopRecord;
        if (this.stopRequested) {
          await this.commit(transition(record, 'STOPPED', 'stopped by user', this.clock));
          continue;
        }
        if (this.pauseRequested) {
          await this.commit(transition(record, 'PAUSED', 'paused by user', this.clock));
          continue;
        }
        if (signal.aborted) {
          await this.commit(transition(record, 'STOPPED', 'cancelled', this.clock));
          continue;
        }
        if (++steps > maxSteps) {
          await this.finishStep(record, this.blockedOutcome(record, new LoopError('LOOP_LIMIT', `Controller step guard tripped after ${maxSteps} steps`)), this.clock.now().toISOString());
          continue;
        }
        if (!(await this.deps.workspaceAvailable())) {
          await this.finishStep(record, this.blockedOutcome(record, new LoopError('WORKSPACE_ERROR', 'The workspace folder is no longer available')), this.clock.now().toISOString());
          continue;
        }
        const startedAt = this.clock.now().toISOString();
        const handler = PHASES[record.state as keyof typeof PHASES];
        this.logger.info(`▶ ${record.state} (iteration ${record.iteration})`);
        let outcome: StepOutcome;
        try {
          outcome = await handler(
            {
              deps: this.deps,
              signal,
              persist: async (r) => {
                await this.commit(r);
              },
            },
            record,
          );
        } catch (error) {
          const e = toLoopError(error, 'WORKSPACE_ERROR', `${record.state} step failed`);
          const latest = this.requireRecord();
          if (e.code === 'USER_CANCELLED' || signal.aborted) {
            const to: LoopState = !this.stopRequested && this.pauseRequested ? 'PAUSED' : 'STOPPED';
            this.logger.warn(`${record.state} cancelled → ${to}`);
            const after = transition(latest, to, to === 'PAUSED' ? 'interrupted; step will re-run on resume' : 'stopped by user', this.clock);
            await this.commit(await this.writeHistory(latest, after, [{ notes: ['cancelled'] }], startedAt, 'cancelled'));
            continue;
          }
          this.logger.error(`${e.code}: ${e.message}`, { state: record.state, ...(e.details ?? {}) });
          if (!isLoopError(error) && error instanceof Error && error.stack) this.logger.debug(error.stack);
          outcome = this.blockedOutcome(latest, e);
        }
        await this.finishStep(record, outcome, startedAt);
      }
    } finally {
      await this.deps.lock?.release().catch((error: unknown) => this.logger.warn(`Failed to release run lock: ${String(error)}`));
    }
  }

  private async finishStep(before: LoopRecord, outcome: StepOutcome, startedAt: string): Promise<void> {
    let after = transition(outcome.record, outcome.next, outcome.reason, this.clock);
    if (outcome.next === 'BLOCKED' && outcome.blocked) {
      after = { ...after, blocked: outcome.blocked };
      this.logger.error(`BLOCKED (${outcome.blocked.code}): ${outcome.blocked.message}`);
    } else {
      this.logger.info(`${before.state} → ${outcome.next}: ${outcome.reason}`);
    }
    if (outcome.next !== 'FIX' && outcome.next !== 'IMPLEMENT') {
      delete after.currentAgent;
    }
    after = await this.writeHistory(before, after, outcome.history, startedAt, outcome.reason);
    await this.commit(after);
  }
}

export function describeBlocked(record: LoopRecord): string | undefined {
  return record.blocked ? `${record.blocked.code as ErrorCode}: ${record.blocked.message}` : undefined;
}
