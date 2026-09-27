import { describe, expect, it } from 'vitest';
import type { ReviewOutput } from '../src/agents/agent-output';
import { evaluateCompletion, evaluateCriteria, evaluateGateRef, evaluateRequirements, mergeReview, ruleMatches } from '../src/controller/completion';
import type { Diagnostic, GateResult } from '../src/gates/gate-types';
import type { CriterionRecord } from '../src/persistence/models';
import { parseTask } from '../src/tasks/task-loader';
import { newValidator } from './helpers';

const task = parseTask(
  `
id: C-1
title: t
goal: g
acceptance:
  - id: AC-001
    description: tested behaviour
    evidence: { tests: [test/a_test.dart] }
  - id: AC-002
    description: architecture holds
    evidence: { gates: [arch] }
  - id: AC-003
    description: reviewer judged
gates: [tests, arch]
requirements:
  no_flutter_in_domain: { gates: [arch.domain_flutter] }
`,
  newValidator(),
  new Set(['tests', 'arch']),
);

function gate(id: string, status: GateResult['status'], diagnostics: Diagnostic[] = [], metrics: GateResult['metrics'] = {}): GateResult {
  return { gateId: id, gateName: id, category: id === 'tests' ? 'test' : 'architecture', status, passed: status === 'passed', exitCode: status === 'passed' ? 0 : 1, stdout: '', stderr: '', diagnostics, warningsBlock: false, metrics, durationMs: 1, timedOut: false, startedAt: '' };
}
const green = [gate('tests', 'passed', [], { passedTestFiles: ['test/a_test.dart'], failedTestFiles: [] }), gate('arch', 'passed')];
const existsAll = async () => true;
const pass: ReviewOutput = { verdict: 'PASS', reasons: [], criteria: ['AC-001', 'AC-002', 'AC-003'].map((id) => ({ id, status: 'met' as const, evidence: ['lib/a.dart'] })), findings: [] };

async function ctxFor(results: GateResult[], exists = existsAll) {
  const { criteria, diagnostics } = await evaluateCriteria(task, [], results, exists);
  return { task, gateResults: results, criteria, requirements: evaluateRequirements(task, results), controllerDiagnostics: diagnostics };
}

describe('completion', () => {
  it('gate failure → NOT COMPLETE and the reviewer is not consulted', async () => {
    let reviewed = false;
    const r = await evaluateCompletion(await ctxFor([green[0]!, gate('arch', 'failed', [{ gate: 'arch', category: 'architecture', severity: 'error', message: 'x' }])]), async () => { reviewed = true; return pass; }, existsAll);
    expect(r.complete).toBe(false);
    expect(reviewed).toBe(false);
    expect(r.reasons.join()).toMatch(/required gate 'arch' failed/);
  });

  it('a gate that did not run → NOT COMPLETE', async () => {
    const r = await evaluateCompletion(await ctxFor([green[0]!]), async () => pass, existsAll);
    expect(r.complete).toBe(false);
    expect(r.reasons.join()).toMatch(/did not run/);
  });

  it('missing acceptance criterion accounting → NOT COMPLETE', async () => {
    const partial: ReviewOutput = { ...pass, criteria: pass.criteria.filter((c) => c.id !== 'AC-003') };
    const r = await evaluateCompletion(await ctxFor(green), async () => partial, existsAll);
    expect(r.complete).toBe(false);
    expect(r.criteria.find((c) => c.id === 'AC-003')?.status).toBe('unknown');
  });

  it('review FAIL → NOT COMPLETE', async () => {
    const r = await evaluateCompletion(await ctxFor(green), async () => ({ ...pass, verdict: 'FAIL', reasons: ['bad'] }), existsAll);
    expect(r.complete).toBe(false);
    expect(r.reasons.join()).toMatch(/verdict FAIL/);
  });

  it('invalid/absent review → NOT COMPLETE', async () => {
    const r = await evaluateCompletion(await ctxFor(green), async () => undefined, existsAll);
    expect(r.complete).toBe(false);
  });

  it('all gates + criteria + review PASS → COMPLETE', async () => {
    const r = await evaluateCompletion(await ctxFor(green), async () => pass, existsAll);
    expect(r.reasons).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.criteria.map((c) => c.status)).toEqual(['verified', 'verified', 'verified']);
  });

  it('the reviewer cannot override a deterministic failure', async () => {
    const criteria: CriterionRecord[] = [{ id: 'AC-001', description: '', required: true, status: 'failed', evidence: [] }];
    const merged = await mergeReview(criteria, pass, existsAll);
    expect(merged[0]?.status).toBe('failed');
  });

  it('requires reviewer evidence to exist', async () => {
    const criteria: CriterionRecord[] = [{ id: 'AC-003', description: '', required: true, status: 'in_progress', evidence: [] }];
    const merged = await mergeReview(criteria, pass, async () => false);
    expect(merged[0]?.status).toBe('unknown');
  });

  it('declared test evidence must exist and pass', async () => {
    const missing = await evaluateCriteria(task, [], green, async (p) => p !== 'test/a_test.dart');
    expect(missing.criteria[0]?.status).toBe('in_progress');
    expect(missing.diagnostics[0]?.rule).toBe('acceptance_test_missing');
    const failing = await evaluateCriteria(task, [], [gate('tests', 'failed', [], { passedTestFiles: [], failedTestFiles: ['test/a_test.dart'] }), green[1]!], existsAll);
    expect(failing.criteria[0]?.status).toBe('failed');
  });

  it('maps requirements to gate rules', () => {
    const arch = gate('arch', 'failed', [{ gate: 'arch', category: 'architecture', severity: 'error', rule: '.github.architecture.domain-flutter', message: 'x' }]);
    expect(evaluateGateRef('arch.domain_flutter', [arch]).satisfied).toBe(false);
    expect(evaluateGateRef('arch.other_rule', [arch]).satisfied).toBe(true);
    expect(evaluateGateRef('arch', [arch]).satisfied).toBe(false);
    expect(evaluateGateRef('arch.domain_flutter', [gate('arch', 'error')]).satisfied).toBe(false);
    expect(evaluateRequirements(task, [arch])[0]).toMatchObject({ name: 'no_flutter_in_domain', satisfied: false });
    expect(ruleMatches('dart.rules.no_bloc', 'no-bloc')).toBe(true);
    expect(ruleMatches('no_blocker', 'no_bloc')).toBe(false);
  });
});
