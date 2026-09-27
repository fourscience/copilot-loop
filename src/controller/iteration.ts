import { LoopError } from '../core/errors';
import type { GateResult } from '../gates/gate-types';
import type { AgentRunSummary, GateRunSummary, LoopRecord } from '../persistence/models';

const MAX_DIAGNOSTICS_STORED_PER_GATE = 200;
const MAX_RECENT_AGENTS = 20;

export function iterationsUsed(record: LoopRecord): number {
  return record.iteration - record.iterationBase;
}

export function agentRunsUsed(record: LoopRecord): number {
  return record.agentRuns - record.agentRunBase;
}

/** Throws LOOP_LIMIT when another modification iteration would exceed the task limits. */
export function assertIterationAvailable(record: LoopRecord): void {
  if (iterationsUsed(record) >= record.task.limits.maxIterations) {
    throw new LoopError('LOOP_LIMIT', `Iteration limit reached (${record.task.limits.maxIterations}). Use Retry to grant another budget after reviewing the state.`, { iteration: record.iteration });
  }
}

export function assertAgentRunAvailable(record: LoopRecord): void {
  if (agentRunsUsed(record) >= record.task.limits.maxAgentRuns) {
    throw new LoopError('LOOP_LIMIT', `Agent run limit reached (${record.task.limits.maxAgentRuns}).`, { agentRuns: record.agentRuns });
  }
}

export function summariseGate(result: GateResult): GateRunSummary {
  return {
    gateId: result.gateId,
    status: result.status,
    exitCode: result.exitCode,
    diagnosticCount: result.diagnostics.length,
    durationMs: result.durationMs,
    metrics: result.metrics,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

/** Result copy suitable for state.json: raw output is dropped (it lives in history). */
export function stripGateResult(result: GateResult): GateResult {
  return { ...result, stdout: '', stderr: '', diagnostics: result.diagnostics.slice(0, MAX_DIAGNOSTICS_STORED_PER_GATE) };
}

export function pushRecentAgent(record: LoopRecord, summary: AgentRunSummary): AgentRunSummary[] {
  return [...record.recentAgents, summary].slice(-MAX_RECENT_AGENTS);
}
