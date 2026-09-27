import { applyDiagnosis, routeFailures } from '../agents/agent-router';
import type { OutputTypes } from '../agents/agent-output';
import type { CopilotClient } from '../copilot/copilot-client';
import { LoopError, type ErrorCode } from '../core/errors';
import type { Clock, Logger } from '../core/ports';
import { truncateTail } from '../core/text';
import { analyseGateResults, makeProgressSample, repeatedFailures, stagnationLength, updateFingerprints } from '../diagnosis/failure-analyzer';
import { fingerprint, fingerprintKey } from '../diagnosis/failure-fingerprint';
import type { AgentRegistry } from '../agents/agent-registry';
import type { GateRunner } from '../gates/gate-runner';
import type { Diagnostic, GateResult } from '../gates/gate-types';
import type { AgentId, AgentRunSummary, Assignment, BlockedReason, GateRunSummary, LoopRecord, LoopState, ReviewRecord } from '../persistence/models';
import type { Git } from '../workspace/git';
import type { Repository } from '../workspace/repository';
import { invokeAgent, type InvocationResult, type InvokerDependencies } from './agent-invoker';
import { evaluateCompletion, evaluateCriteria, evaluateRequirements, requiredTestDiagnostics } from './completion';
import { assertAgentRunAvailable, assertIterationAvailable, pushRecentAgent, stripGateResult, summariseGate } from './iteration';

export interface PhaseDependencies {
  workspaceRoot: string;
  client: CopilotClient;
  agents: AgentRegistry;
  gates: GateRunner;
  repository: Repository;
  git: Git;
  clock: Clock;
  logger: Logger;
  invoker: InvokerDependencies;
}

export interface PhaseContext {
  deps: PhaseDependencies;
  signal: AbortSignal;
  /** Persists intermediate progress within a step (state unchanged). */
  persist: (record: LoopRecord) => Promise<void>;
}

export interface HistoryPart {
  agent?: AgentId;
  model?: string;
  agentRun?: AgentRunSummary;
  transcript?: { role: string; text: string }[];
  gates?: GateRunSummary[];
  diagnostics?: Diagnostic[];
  gateOutput?: { gateId: string; stdout: string; stderr: string }[];
  notes: string[];
}

export interface StepOutcome {
  record: LoopRecord;
  next: LoopState;
  reason: string;
  blocked?: BlockedReason;
  history: HistoryPart[];
}

export type PhaseHandler = (ctx: PhaseContext, record: LoopRecord) => Promise<StepOutcome>;

function block(record: LoopRecord, code: ErrorCode, message: string, history: HistoryPart[] = [], details?: Record<string, unknown>): StepOutcome {
  return { record, next: 'BLOCKED', reason: message, blocked: { code, message, ...(details ? { details } : {}) }, history: history.length ? history : [{ notes: [message] }] };
}

function exists(deps: PhaseDependencies): (p: string) => Promise<boolean> {
  return (p) => deps.repository.exists(p);
}

async function changedFiles(deps: PhaseDependencies, record: LoopRecord, writes: readonly string[], signal: AbortSignal): Promise<string[]> {
  if (record.baseline && (await deps.git.isRepository())) {
    return deps.git.changedBetween(record.baseline, await deps.git.snapshot(signal));
  }
  return [...new Set([...record.changedFiles, ...writes])].sort();
}

async function maybeCheckpoint(deps: PhaseDependencies, record: LoopRecord): Promise<LoopRecord> {
  if (!record.task.git.checkpoints) return record;
  const ref = await deps.git.createCheckpoint(record.runId, `iteration-${String(record.iteration).padStart(4, '0')}`);
  deps.logger.info(`Checkpoint created: ${ref}`);
  return { ...record, checkpoints: [...record.checkpoints, { iteration: record.iteration, ref, at: deps.clock.now().toISOString() }] };
}

function claimIteration(record: LoopRecord, state: LoopState): { record: LoopRecord; claimed: boolean } {
  if (record.claimedIteration?.state === state) return { record, claimed: false };
  assertIterationAvailable(record);
  const iteration = record.iteration + 1;
  return { record: { ...record, iteration, claimedIteration: { state, iteration } }, claimed: true };
}

function recordAgent<K extends keyof OutputTypes>(record: LoopRecord, inv: InvocationResult<K>): LoopRecord {
  return { ...record, agentRuns: record.agentRuns + 1, recentAgents: pushRecentAgent(record, inv.summary), currentAgent: inv.summary.agent, currentModel: inv.model.id };
}

function agentHistory<K extends keyof OutputTypes>(inv: InvocationResult<K>, notes: string[] = []): HistoryPart {
  return { agent: inv.summary.agent, model: inv.model.id, agentRun: inv.summary, transcript: inv.result.transcript, notes };
}

async function runAgent<K extends keyof OutputTypes>(
  ctx: PhaseContext,
  record: LoopRecord,
  agentId: AgentId,
  options: Parameters<typeof invokeAgent>[3],
): Promise<{ record: LoopRecord; inv: InvocationResult<K> }> {
  assertAgentRunAvailable(record);
  const inv = await invokeAgent<K>(ctx.deps.invoker, { ...record, currentAgent: agentId }, agentId, { ...options, signal: ctx.signal });
  return { record: recordAgent(record, inv), inv };
}

// ---------------------------------------------------------------------------

export const intake: PhaseHandler = async (ctx, record) => {
  const { deps } = ctx;
  const notes: string[] = [];
  const problems = await deps.gates.preflight(record.task.gates, deps.workspaceRoot);
  if (problems.length > 0) {
    return block(record, 'CONFIGURATION_ERROR', `Required gates cannot execute:\n- ${problems.join('\n- ')}`, [], { problems });
  }
  deps.agents.assertComplete();
  const models = await deps.client.listModels(ctx.signal);
  if (models.length === 0) {
    return block(record, 'MODEL_UNAVAILABLE', 'No GitHub Copilot chat model is available. Sign in to GitHub Copilot, and check that your organization enables Copilot Chat models in VS Code.');
  }
  notes.push(`models available: ${models.map((m) => m.id).join(', ')}`);
  const isRepo = await deps.git.isRepository();
  if (record.task.git.checkpoints && !isRepo) {
    return block(record, 'CONFIGURATION_ERROR', 'git.checkpoints is enabled but the workspace is not a git repository');
  }
  if (!isRepo) notes.push('workspace is not a git repository: diffs and precise change tracking are unavailable');
  const baseline = record.baseline ?? (await deps.git.snapshot(ctx.signal));
  return { record: { ...record, baseline }, next: 'PLAN', reason: 'intake checks passed', history: [{ notes }] };
};

export const plan: PhaseHandler = async (ctx, record) => {
  if (record.plan) {
    return { record, next: 'IMPLEMENT', reason: 'plan already exists', history: [{ notes: ['reusing existing plan'] }] };
  }
  const { record: updated, inv } = await runAgent<'plan'>(ctx, record, 'architect', {
    assignmentText: 'Study the task and the relevant parts of the repository, then produce the implementation plan. Map every acceptance criterion id to an approach and concrete evidence (tests). Do not change files.',
  });
  if (inv.result.outcome !== 'completed' || !inv.result.output) {
    return block(updated, 'MODEL_REQUEST_FAILED', `Architect did not produce a valid plan (${inv.result.outcome}: ${inv.result.outputError ?? 'no output'})`, [agentHistory(inv)]);
  }
  const planOutput = inv.result.output;
  const known = new Set(record.task.acceptance.map((c) => c.id));
  const notes = planOutput.criteria.filter((c) => !known.has(c.id)).map((c) => `plan referenced unknown criterion ${c.id}`);
  return { record: { ...updated, plan: planOutput }, next: 'IMPLEMENT', reason: 'plan produced', history: [agentHistory(inv, notes)] };
};

export const implement: PhaseHandler = async (ctx, record) => {
  let { record: r } = claimIteration(record, 'IMPLEMENT');
  r = await maybeCheckpoint(ctx.deps, r);
  await ctx.persist(r);
  const writes: string[] = [];
  const { record: updated, inv } = await runAgent<'change'>(ctx, r, 'implementer', {
    assignmentText: 'Implement the plan in context.plan. Satisfy every acceptance criterion, add the required tests, and respect every constraint. Make focused changes that follow existing patterns.',
    extraFiles: (r.plan?.affectedFiles ?? []).slice(0, 4),
    onWrite: (p) => writes.push(p),
  });
  const criteria = updated.criteria.map((c) => (c.status === 'unknown' ? { ...c, status: 'in_progress' as const } : c));
  const changed = await changedFiles(ctx.deps, updated, writes, ctx.signal);
  const { claimedIteration: _drop, ...rest } = updated;
  return { record: { ...rest, criteria, changedFiles: changed }, next: 'VALIDATE', reason: `implementer ${inv.result.outcome}`, history: [agentHistory(inv)] };
};

function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = fingerprintKey(fingerprint(d));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const validate: PhaseHandler = async (ctx, record) => {
  const { deps } = ctx;
  const results: GateResult[] = await deps.gates.runAll(record.task.gates, { workspaceRoot: deps.workspaceRoot, signal: ctx.signal });
  const gateOutput = results.map((g) => ({ gateId: g.gateId, stdout: truncateTail(g.stdout, 8000), stderr: truncateTail(g.stderr, 8000) }));
  const gates = results.map(summariseGate);
  const stripped = results.map(stripGateResult);
  const errored = results.filter((g) => g.status === 'error');
  if (errored.length > 0) {
    const message = `Required gate(s) could not execute:\n- ${errored.map((g) => g.error?.message ?? g.gateId).join('\n- ')}`;
    return block({ ...record, lastGateResults: stripped }, 'CONFIGURATION_ERROR', message, [{ gates, gateOutput, notes: [message] }]);
  }

  const snapshot = analyseGateResults(results);
  const { criteria, diagnostics: criteriaDiagnostics } = await evaluateCriteria(record.task, record.criteria, results, exists(deps));
  const controllerDiagnostics = dedupe([...criteriaDiagnostics, ...(await requiredTestDiagnostics(record.task, results, exists(deps)))]);
  const failures = dedupe([...snapshot.failures, ...controllerDiagnostics]);
  const fingerprints = failures.map((d) => ({ key: fingerprintKey(fingerprint(d)), fingerprint: fingerprint(d) }));
  const fpRecords = updateFingerprints(record.fingerprints, { ...snapshot, fingerprints }, record.iteration);
  const changed = await changedFiles(deps, record, [], ctx.signal);
  const lastAgent = record.lastFixAgents.join('+') || record.recentAgents.at(-1)?.agent;
  const sample = makeProgressSample(record.iteration, { ...snapshot, fingerprints }, changed.length, lastAgent);
  const next: LoopRecord = {
    ...record,
    lastGateResults: stripped,
    lastFailures: failures,
    controllerDiagnostics,
    criteria,
    requirements: evaluateRequirements(record.task, results),
    fingerprints: fpRecords,
    progress: [...record.progress, sample].slice(-100),
    changedFiles: changed,
    validatedWorkspace: await deps.git.workspaceFingerprint(ctx.signal),
  };
  const history: HistoryPart = { gates, gateOutput, diagnostics: failures.slice(0, 200), notes: [`${failures.length} blocking failure(s); ${snapshot.passingGates.length}/${results.length} gates passing`] };

  if (failures.length === 0) {
    return { record: next, next: 'REVIEW', reason: 'all gates passed', history: [history] };
  }
  const repeated = repeatedFailures(fpRecords, record.task.limits.maxSameFailure);
  if (repeated.length > 0) {
    const list = repeated.slice(0, 10).map((r) => `${r.fingerprint.gate}${r.fingerprint.rule ? `/${r.fingerprint.rule}` : ''}${r.fingerprint.file ? ` @ ${r.fingerprint.file}` : ''} (seen ${r.consecutive}x)`);
    return block(next, 'REPEATED_FAILURE', `The same failure persisted for ${record.task.limits.maxSameFailure} consecutive validations:\n- ${list.join('\n- ')}`, [history], { fingerprints: repeated.map((r) => r.fingerprint) });
  }
  return { record: next, next: 'DIAGNOSE', reason: `${failures.length} failure(s)`, history: [history] };
};

export const diagnose: PhaseHandler = async (ctx, record) => {
  const limits = record.task.limits;
  const stagnation = stagnationLength(record.progress);
  const escalation = Math.floor(stagnation / limits.maxNoProgress);
  const notes = [`stagnation=${stagnation}, escalation=${escalation}`];
  if (escalation >= 3) {
    return block({ ...record, escalation }, 'REPEATED_FAILURE', `No measurable progress for ${stagnation} validations, even after consulting the diagnoser and switching specialists. Human intervention required.`, [{ notes }]);
  }
  const failures = record.lastFailures;
  const decision = routeFailures(failures, { escalation, previousAgents: record.lastFixAgents });
  let assignments = decision.assignments;
  let r: LoopRecord = { ...record, escalation };
  const history: HistoryPart[] = [];
  if (decision.consultDiagnoser) {
    const { record: updated, inv } = await runAgent<'diagnosis'>(ctx, r, 'diagnoser', {
      diagnostics: failures,
      assignmentText: escalation >= 1
        ? 'The loop is not making progress on these failures. Identify the real root causes and recommend a specialist for each; consult previousAttempts and avoid repeating what failed.'
        : 'Classify these failures by root cause and recommend exactly one specialist for each root cause.',
    });
    r = updated;
    history.push(agentHistory(inv));
    assignments = applyDiagnosis(decision, inv.result.outcome === 'completed' && inv.result.output ? inv.result.output : { diagnoses: [] }, failures);
  }
  if (assignments.length === 0) {
    assignments = [{ agent: 'implementer', category: 'unknown', diagnostics: failures.slice(0, 40), reason: 'no specialist matched; implementer fallback' }];
  }
  notes.push(...assignments.map((a) => `${a.agent}: ${a.reason} (${a.diagnostics.length} diagnostics)`));
  history.push({ diagnostics: failures.slice(0, 100), notes });
  return { record: { ...r, pending: assignments }, next: 'FIX', reason: `routed to ${assignments.map((a) => a.agent).join(', ')}`, history };
};

function assignmentText(a: Assignment): string {
  return [
    `Fix the ${a.diagnostics.length} diagnostic(s) in context.diagnostics that were routed to you (${a.reason}).`,
    'Address root causes. Do not modify protected files, rules, gates or test intent. The controller re-runs every gate after you finish.',
  ].join('\n');
}

export const fix: PhaseHandler = async (ctx, record) => {
  const claim = claimIteration(record, 'FIX');
  const claimed = claim.claimed;
  let r = claim.record;
  if (claimed) r = await maybeCheckpoint(ctx.deps, r);
  await ctx.persist(r);
  const history: HistoryPart[] = [];
  const writes: string[] = [];
  const used = new Set(r.lastFixAgents.filter(() => !claimed));
  while (r.pending.length > 0) {
    const assignment = r.pending[0] as Assignment;
    const { record: updated, inv } = await runAgent<'change'>(ctx, r, assignment.agent, { assignment, assignmentText: assignmentText(assignment), onWrite: (p) => writes.push(p) });
    used.add(assignment.agent);
    // Persist after each specialist so an interruption never repeats completed work.
    r = { ...updated, pending: updated.pending.slice(1), lastFixAgents: [...used] };
    await ctx.persist(r);
    history.push(agentHistory(inv, [assignment.reason]));
  }
  const changed = await changedFiles(ctx.deps, r, writes, ctx.signal);
  const { claimedIteration: _drop, ...rest } = r;
  return { record: { ...rest, changedFiles: changed, lastFixAgents: [...used], unstableReviews: 0 }, next: 'VALIDATE', reason: `specialists finished: ${[...used].join(', ')}`, history: history.length ? history : [{ notes: ['no pending assignments'] }] };
};

function reviewDiagnostics(review: ReviewRecord, criteria: LoopRecord['criteria']): Diagnostic[] {
  const out: Diagnostic[] = review.findings.map((f) => ({ gate: 'review', category: f.category, severity: 'error' as const, rule: 'review_finding', message: f.message, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}) }));
  for (const c of criteria) {
    if (c.required && c.status !== 'verified') {
      out.push({ gate: 'review', category: 'unknown', severity: 'error', rule: `criterion_${c.id}`, message: `Acceptance criterion ${c.id} (${c.description}) is ${c.status}${c.notes ? `: ${c.notes}` : ''}` });
    }
  }
  if (out.length === 0) {
    out.push({ gate: 'review', category: 'unknown', severity: 'error', rule: 'review_rejected', message: `Reviewer rejected the change: ${review.reasons.join('; ') || 'no reason given'}` });
  }
  return out;
}

const MAX_UNSTABLE_REVIEWS = 3;

/** Re-validates when files changed outside the loop, but never ping-pongs forever. */
function unstableWorkspace(record: LoopRecord, reason: string): StepOutcome {
  const unstable = record.unstableReviews + 1;
  if (unstable >= MAX_UNSTABLE_REVIEWS) {
    return block({ ...record, unstableReviews: unstable }, 'WORKSPACE_ERROR', `The workspace keeps changing between validation and review (${unstable} times). Another process or editor may be modifying files; stop it and Retry.`);
  }
  return { record: { ...record, unstableReviews: unstable }, next: 'VALIDATE', reason, history: [{ notes: [`${reason}; re-validating (${unstable}/${MAX_UNSTABLE_REVIEWS})`] }] };
}

export const review: PhaseHandler = async (ctx, record) => {
  const { deps } = ctx;
  if (record.lastGateResults.length === 0 || !record.validatedWorkspace) {
    return { record, next: 'VALIDATE', reason: 'no validation results to review', history: [{ notes: ['re-validating'] }] };
  }
  if ((await deps.git.workspaceFingerprint(ctx.signal)) !== record.validatedWorkspace) {
    return unstableWorkspace(record, 'workspace changed since the last validation');
  }
  let r = record;
  let inv: InvocationResult<'review'> | undefined;
  const decision = await evaluateCompletion(
    { task: r.task, gateResults: r.lastGateResults, criteria: r.criteria, requirements: r.requirements, controllerDiagnostics: r.controllerDiagnostics },
    async () => {
      const run = await runAgent<'review'>(ctx, r, 'reviewer', {
        assignmentText: 'All deterministic gates pass. Review the actual diff against every acceptance criterion and constraint. Return PASS only if every criterion is met with evidence that exists in the workspace.',
      });
      r = run.record;
      inv = run.inv;
      return run.inv.result.outcome === 'completed' ? run.inv.result.output : undefined;
    },
    exists(deps),
  );
  const history: HistoryPart[] = inv ? [agentHistory(inv, decision.reasons)] : [{ notes: decision.reasons }];
  if (!decision.reviewed) {
    // Pre-review checks failed although validation routed here: controller invariant violated. Never loop on it.
    return block(r, 'CONFIGURATION_ERROR', `Completion preconditions failed after a passing validation: ${decision.reasons.join('; ')}`, history);
  }
  if (!decision.review) {
    const invResult = (inv as InvocationResult<'review'> | undefined)?.result;
    return block({ ...r, criteria: decision.criteria }, 'MODEL_REQUEST_FAILED', `Reviewer did not return a valid verdict (${invResult?.outcome ?? 'no result'}: ${invResult?.outputError ?? ''})`, history);
  }
  const reviewRecord: ReviewRecord = { ...decision.review, at: deps.clock.now().toISOString() };
  r = { ...r, criteria: decision.criteria, lastReview: reviewRecord };
  if (decision.complete) {
    // The reviewer is read-only, but completion must describe exactly the validated tree.
    if ((await deps.git.workspaceFingerprint(ctx.signal)) !== record.validatedWorkspace) {
      return unstableWorkspace(r, 'workspace changed during review');
    }
    return { record: { ...r, unstableReviews: 0 }, next: 'DONE', reason: 'all gates passed, all acceptance criteria verified, reviewer PASS', history };
  }
  const rejections = r.reviewRejections + 1;
  r = { ...r, reviewRejections: rejections, lastFailures: reviewDiagnostics(reviewRecord, decision.criteria) };
  if (rejections >= r.task.limits.maxReviewRejections) {
    return block(r, 'REPEATED_FAILURE', `Review rejected the change ${rejections} time(s): ${decision.reasons.join('; ')}`, history);
  }
  return { record: r, next: 'DIAGNOSE', reason: `not complete: ${decision.reasons.slice(0, 3).join('; ')}`, history };
};

export const PHASES: Readonly<Record<'INTAKE' | 'PLAN' | 'IMPLEMENT' | 'VALIDATE' | 'DIAGNOSE' | 'FIX' | 'REVIEW', PhaseHandler>> = {
  INTAKE: intake,
  PLAN: plan,
  IMPLEMENT: implement,
  VALIDATE: validate,
  DIAGNOSE: diagnose,
  FIX: fix,
  REVIEW: review,
};

export function isLoopErrorWithCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof LoopError && error.code === code;
}
