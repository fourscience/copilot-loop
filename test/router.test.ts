import { describe, expect, it } from 'vitest';
import { applyDiagnosis, routeFailures } from '../src/agents/agent-router';
import { diag } from './helpers';

describe('router', () => {
  it.each([
    ['architecture', 'architecture-fixer'],
    ['test', 'test-engineer'],
    ['compile', 'debugger'],
    ['security', 'security'],
    ['lint', 'refactoring'],
    ['coverage', 'test-engineer'],
  ] as const)('routes %s → %s', (category, agent) => {
    const decision = routeFailures([diag(category)]);
    expect(decision.assignments.map((a) => a.agent)).toEqual([agent]);
    expect(decision.consultDiagnoser).toBe(false);
  });

  it('sends unknown failures to the diagnoser', () => {
    const decision = routeFailures([diag('unknown')]);
    expect(decision.assignments).toEqual([]);
    expect(decision.unrouted).toHaveLength(1);
    expect(decision.consultDiagnoser).toBe(true);
  });

  it('fixes compile errors first and alone', () => {
    const decision = routeFailures([diag('test'), diag('compile'), diag('lint')]);
    expect(decision.assignments.map((a) => a.agent)).toEqual(['debugger']);
  });

  it('orders multiple specialists deterministically and merges shared agents', () => {
    const decision = routeFailures([diag('lint'), diag('coverage'), diag('architecture'), diag('test'), diag('security')]);
    expect(decision.assignments.map((a) => a.agent)).toEqual(['security', 'architecture-fixer', 'test-engineer', 'refactoring']);
    expect(decision.assignments.find((a) => a.agent === 'test-engineer')?.diagnostics).toHaveLength(2);
  });

  it('consults the diagnoser at escalation 1 and switches specialist at escalation 2', () => {
    expect(routeFailures([diag('test')], { escalation: 1, previousAgents: ['test-engineer'] }).consultDiagnoser).toBe(true);
    const switched = routeFailures([diag('test')], { escalation: 2, previousAgents: ['test-engineer'] });
    expect(switched.assignments.map((a) => a.agent)).toEqual(['implementer']);
    expect(switched.assignments[0]?.reason).toMatch(/no progress/);
  });

  it('applies diagnoser recommendations and keeps unclaimed failures routed', () => {
    const failures = [diag('unknown', { file: 'lib/a.dart' }), diag('lint', { file: 'lib/b.dart' })];
    const decision = routeFailures(failures);
    const assignments = applyDiagnosis(decision, { diagnoses: [{ category: 'architecture', severity: 'error', rootCause: 'domain imports flutter', affectedFiles: ['lib/a.dart'], recommendedAgent: 'architecture-fixer' }] }, failures);
    expect(assignments.map((a) => a.agent)).toEqual(['architecture-fixer', 'refactoring']);
    expect(assignments[0]?.diagnostics[0]?.file).toBe('lib/a.dart');
  });

  it('gives unclaimed unknown failures to the implementer', () => {
    const failures = [diag('unknown', { file: 'x.dart' })];
    const assignments = applyDiagnosis(routeFailures(failures), { diagnoses: [] }, failures);
    expect(assignments.map((a) => a.agent)).toEqual(['implementer']);
  });
});
