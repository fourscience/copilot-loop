import type { ReviewOutput } from '../agents/agent-output';
import { blockingDiagnostics, type Diagnostic, type GateResult } from '../gates/gate-types';
import type { CriterionRecord, CriterionStatus, RequirementStatus } from '../persistence/models';
import { parseGateRef, type TaskContract } from '../tasks/task-schema';

export type FileExists = (relativePath: string) => Promise<boolean>;

/** `opengrep.domain_flutter` matches rule ids like `domain_flutter`, `domain-flutter` or `.github.architecture.domain_flutter`. */
export function ruleMatches(ruleId: string | undefined, ref: string): boolean {
  if (!ruleId) return false;
  const norm = (s: string): string => s.toLowerCase().replace(/[-\s]/g, '_');
  const r = norm(ruleId);
  const f = norm(ref);
  return r === f || r.endsWith(`.${f}`) || r.endsWith(`/${f}`);
}

export interface GateRefResult {
  ref: string;
  satisfied: boolean;
  reason?: string;
}

/**
 * A plain gate reference is satisfied when the gate passed. A rule reference
 * (`gate.rule`) is satisfied when the gate executed and reported no blocking
 * diagnostic for that rule. A gate that did not run never satisfies anything.
 */
export function evaluateGateRef(ref: string, results: readonly GateResult[]): GateRefResult {
  const { gate, rule } = parseGateRef(ref);
  const result = results.find((r) => r.gateId === gate);
  if (!result) return { ref, satisfied: false, reason: `gate '${gate}' has not run` };
  if (result.status === 'error') return { ref, satisfied: false, reason: `gate '${gate}' could not execute` };
  if (!rule) return result.status === 'passed' ? { ref, satisfied: true } : { ref, satisfied: false, reason: `gate '${gate}' failed` };
  const violations = blockingDiagnostics(result).filter((d) => ruleMatches(d.rule, rule));
  return violations.length === 0 ? { ref, satisfied: true } : { ref, satisfied: false, reason: `${violations.length} violation(s) of ${ref}` };
}

export function evaluateRequirements(task: TaskContract, results: readonly GateResult[]): RequirementStatus[] {
  return task.requirements.map((req) => {
    const refs = req.gates.map((g) => evaluateGateRef(g, results));
    return { name: req.name, gates: req.gates, satisfied: refs.every((r) => r.satisfied), unmet: refs.filter((r) => !r.satisfied).map((r) => r.reason ?? r.ref) };
  });
}

interface TestEvidence {
  missing: string[];
  failing: string[];
  unconfirmed: string[];
}

/** Checks test files exist and (when the test reporter provides per-file results) passed. */
async function evaluateTests(tests: readonly string[], results: readonly GateResult[], exists: FileExists): Promise<TestEvidence> {
  const testGates = results.filter((r) => r.category === 'test' || r.metrics.passedTestFiles !== undefined);
  const out: TestEvidence = { missing: [], failing: [], unconfirmed: [] };
  for (const test of tests) {
    if (!(await exists(test))) {
      out.missing.push(test);
      continue;
    }
    const withMetrics = testGates.filter((g) => g.metrics.passedTestFiles !== undefined);
    if (withMetrics.length > 0) {
      if (withMetrics.some((g) => g.metrics.failedTestFiles?.includes(test))) out.failing.push(test);
      else if (!withMetrics.some((g) => g.metrics.passedTestFiles?.includes(test))) out.unconfirmed.push(test);
    } else if (testGates.length === 0 || testGates.some((g) => g.status !== 'passed')) {
      out.unconfirmed.push(test);
    }
  }
  return out;
}

export function initialCriteria(task: TaskContract): CriterionRecord[] {
  return task.acceptance.map((c) => ({ id: c.id, description: c.description, required: c.required, status: 'unknown' as CriterionStatus, evidence: [] }));
}

/**
 * Deterministic criterion evaluation after a validation run. Criteria that
 * declare evidence (tests and/or gates) are verified or failed by the
 * controller. Criteria without declared evidence stay `in_progress` until the
 * reviewer accounts for them with evidence.
 */
export async function evaluateCriteria(task: TaskContract, previous: readonly CriterionRecord[], results: readonly GateResult[], exists: FileExists): Promise<{ criteria: CriterionRecord[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const criteria: CriterionRecord[] = [];
  for (const spec of task.acceptance) {
    const prior = previous.find((p) => p.id === spec.id);
    const base: CriterionRecord = { id: spec.id, description: spec.description, required: spec.required, status: 'in_progress', evidence: [], source: 'controller' };
    const hasDeterministic = spec.evidence.tests.length > 0 || spec.evidence.gates.length > 0;
    if (!hasDeterministic) {
      criteria.push({ ...base, ...(prior?.notes ? { notes: prior.notes } : {}) });
      continue;
    }
    const gateRefs = spec.evidence.gates.map((g) => evaluateGateRef(g, results));
    const tests = await evaluateTests(spec.evidence.tests, results, exists);
    const problems = [...gateRefs.filter((g) => !g.satisfied).map((g) => g.reason ?? g.ref), ...tests.failing.map((t) => `test failing: ${t}`), ...tests.missing.map((t) => `test missing: ${t}`), ...tests.unconfirmed.map((t) => `test not confirmed passing: ${t}`)];
    const evidence = [...spec.evidence.gates.map((g) => `gate:${g}`), ...spec.evidence.tests];
    let status: CriterionStatus = 'verified';
    if (gateRefs.some((g) => !g.satisfied) || tests.failing.length > 0) status = 'failed';
    else if (tests.missing.length > 0 || tests.unconfirmed.length > 0) status = 'in_progress';
    criteria.push({ ...base, status, evidence, ...(problems.length ? { notes: problems.join('; ') } : {}) });
    for (const t of tests.missing) {
      diagnostics.push({ gate: 'controller', category: 'test', severity: 'error', file: t, rule: 'acceptance_test_missing', message: `Acceptance criterion ${spec.id} requires test file ${t}, which does not exist` });
    }
  }
  return { criteria, diagnostics };
}

/** Required tests must exist and, when per-file results are available, pass. */
export async function requiredTestDiagnostics(task: TaskContract, results: readonly GateResult[], exists: FileExists): Promise<Diagnostic[]> {
  const t = await evaluateTests(task.requiredTests, results, exists);
  return [
    ...t.missing.map((f) => ({ gate: 'controller', category: 'test' as const, severity: 'error' as const, file: f, rule: 'required_test_missing', message: `Required test ${f} does not exist` })),
    ...t.unconfirmed.map((f) => ({ gate: 'controller', category: 'test' as const, severity: 'error' as const, file: f, rule: 'required_test_not_run', message: `Required test ${f} was not reported as passing by the test gate (is it a valid test file?)` })),
  ];
}

/** Strips `:line` and `#test name` suffixes from reviewer evidence. */
function evidencePath(e: string): string {
  return e.replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '').trim();
}

/**
 * Merges the reviewer's per-criterion judgement. The reviewer can never
 * override a deterministic failure, and a `met` claim only counts when it cites
 * evidence that exists in the workspace.
 */
export async function mergeReview(criteria: readonly CriterionRecord[], review: ReviewOutput, exists: FileExists): Promise<CriterionRecord[]> {
  const merged: CriterionRecord[] = [];
  for (const c of criteria) {
    const judged = review.criteria.find((r) => r.id === c.id);
    if (c.status === 'failed' || c.status === 'blocked') {
      merged.push(c);
    } else if (!judged) {
      merged.push({ ...c, status: c.status === 'verified' ? 'verified' : 'unknown', notes: 'reviewer did not account for this criterion' });
    } else if (judged.status === 'not_met') {
      merged.push({ ...c, status: 'failed', source: 'review', notes: 'reviewer: not met' });
    } else {
      const cited = judged.evidence.map(evidencePath).filter((e) => e && !e.startsWith('gate:'));
      const existing: string[] = [];
      for (const e of cited) if (await exists(e)) existing.push(e);
      if (c.status === 'verified') {
        merged.push({ ...c, evidence: [...new Set([...c.evidence, ...existing])] });
      } else if (existing.length === 0) {
        merged.push({ ...c, status: 'unknown', source: 'review', notes: 'reviewer claimed met without evidence that exists in the workspace' });
      } else if (c.notes && /test (missing|not confirmed)/.test(c.notes)) {
        merged.push(c); // deterministic evidence still outstanding
      } else {
        merged.push({ ...c, status: 'verified', source: 'review', evidence: existing });
      }
    }
  }
  return merged;
}

export interface CompletionContext {
  task: TaskContract;
  gateResults: readonly GateResult[];
  criteria: readonly CriterionRecord[];
  requirements: readonly RequirementStatus[];
  controllerDiagnostics: readonly Diagnostic[];
  limitExceeded?: string;
}

export interface CompletionDecision {
  complete: boolean;
  reasons: string[];
}

/** Everything that must hold before the reviewer is even consulted. */
export function preReviewCheck(ctx: CompletionContext): CompletionDecision {
  const reasons: string[] = [];
  if (ctx.limitExceeded) reasons.push(ctx.limitExceeded);
  for (const gate of ctx.task.gates) {
    const r = ctx.gateResults.find((g) => g.gateId === gate);
    if (!r) reasons.push(`required gate '${gate}' did not run`);
    else if (r.status !== 'passed') reasons.push(`required gate '${gate}' ${r.status}`);
  }
  for (const req of ctx.requirements) if (!req.satisfied) reasons.push(`requirement '${req.name}' unmet: ${req.unmet.join(', ')}`);
  for (const d of ctx.controllerDiagnostics) reasons.push(d.message);
  for (const c of ctx.criteria) {
    if (c.required && (c.status === 'failed' || c.status === 'blocked')) reasons.push(`acceptance ${c.id} is ${c.status}${c.notes ? ` (${c.notes})` : ''}`);
  }
  return { complete: reasons.length === 0, reasons };
}

/** Final decision after the review. The controller, not the reviewer, decides. */
export function finalCheck(ctx: CompletionContext, review: ReviewOutput | undefined): CompletionDecision {
  const pre = preReviewCheck(ctx);
  const reasons = [...pre.reasons];
  for (const c of ctx.criteria) {
    if (c.required && c.status !== 'verified' && c.status !== 'failed' && c.status !== 'blocked') reasons.push(`acceptance ${c.id} is ${c.status}${c.notes ? ` (${c.notes})` : ''}`);
  }
  if (!review) reasons.push('no valid review');
  else if (review.verdict !== 'PASS') reasons.push(`reviewer verdict FAIL: ${review.reasons.join('; ') || 'no reasons given'}`);
  return { complete: reasons.length === 0, reasons };
}

/**
 * Completion evaluator (see README "Completion logic"):
 * gates → acceptance criteria → reviewer PASS → complete. The reviewer is
 * only called when every deterministic precondition holds.
 */
export async function evaluateCompletion(
  ctx: CompletionContext,
  reviewer: () => Promise<ReviewOutput | undefined>,
  exists: FileExists,
): Promise<CompletionDecision & { criteria: CriterionRecord[]; review?: ReviewOutput; reviewed: boolean }> {
  const pre = preReviewCheck(ctx);
  if (!pre.complete) return { ...pre, criteria: [...ctx.criteria], reviewed: false };
  const review = await reviewer();
  const criteria = review ? await mergeReview(ctx.criteria, review, exists) : [...ctx.criteria];
  const decision = finalCheck({ ...ctx, criteria }, review);
  return { ...decision, criteria, ...(review ? { review } : {}), reviewed: true };
}
