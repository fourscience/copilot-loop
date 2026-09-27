import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoopError } from '../src/core/errors';
import { parseTask } from '../src/tasks/task-loader';
import { parseGateRef } from '../src/tasks/task-schema';
import { REPO_ROOT, newValidator } from './helpers';

const GATES = new Set(['dart_analyze', 'flutter_test', 'dcm', 'opengrep', 'architecture', 'security', 'coverage']);

const minimal = `
id: T-1
title: Minimal
goal: Do the thing
acceptance:
  - it works
gates: [flutter_test]
`;

function expectInvalid(yaml: string, pattern: RegExp, gates: Set<string> = GATES): void {
  try {
    parseTask(yaml, newValidator(), gates);
  } catch (error) {
    expect(error).toBeInstanceOf(LoopError);
    expect((error as LoopError).code).toBe('TASK_INVALID');
    expect((error as LoopError).message).toMatch(pattern);
    return;
  }
  throw new Error('expected task to be rejected');
}

describe('task contract', () => {
  it('loads the bundled example task', async () => {
    const text = await fs.readFile(path.join(REPO_ROOT, 'tasks/example.yaml'), 'utf8');
    const task = parseTask(text, newValidator(), GATES);
    expect(task.id).toBe('AUTH-142');
    expect(task.acceptance).toHaveLength(7);
    expect(task.acceptance[0]).toMatchObject({ id: 'AC-001', required: true });
    expect(task.limits).toMatchObject({ maxIterations: 30, maxSameFailure: 3, maxAgentTurns: 30 });
    expect(task.requirements.find((r) => r.name === 'no_flutter_in_domain')?.gates).toEqual(['opengrep.domain_flutter']);
    expect(task.git.checkpoints).toBe(false);
  });

  it('applies defaults and generates criterion ids', () => {
    const task = parseTask(minimal, newValidator(), GATES);
    expect(task.acceptance[0]).toEqual({ id: 'AC-001', description: 'it works', required: true, evidence: { tests: [], gates: [] } });
    expect(task.constraints).toEqual([]);
    expect(task.limits.maxIterations).toBe(30);
  });

  it('rejects malformed YAML', () => {
    expectInvalid('id: [unclosed\ntitle: x', /could not be parsed/);
  });

  it('rejects duplicate keys', () => {
    expectInvalid(`${minimal}\nid: T-2\n`, /could not be parsed/);
  });

  it('rejects missing required fields', () => {
    expectInvalid('id: T-1\ntitle: x\ngoal: y\ngates: [flutter_test]\n', /acceptance/);
  });

  it('rejects unknown top-level properties', () => {
    expectInvalid(`${minimal}\nsurprise: true\n`, /surprise/);
  });

  it('rejects wrong types and out-of-range limits', () => {
    expectInvalid(`${minimal}\nlimits:\n  max_iterations: 0\n`, /max_iterations/);
    expectInvalid(`${minimal}\nlimits:\n  max_iterations: "ten"\n`, /max_iterations/);
    expectInvalid(minimal.replace('gates: [flutter_test]', 'gates: flutter_test'), /gates/);
  });

  it('rejects empty acceptance', () => {
    expectInvalid(minimal.replace('acceptance:\n  - it works', 'acceptance: []'), /acceptance/);
  });

  it('rejects unknown gates', () => {
    expectInvalid(minimal.replace('[flutter_test]', '[nope]'), /gate 'nope' is not defined/);
  });

  it('rejects requirement mappings to gates not listed in the task', () => {
    expectInvalid(`${minimal}\nrequirements:\n  MVVM:\n    gates: [architecture.mvvm]\n`, /requirement 'MVVM' references gate 'architecture.mvvm'/);
  });

  it('rejects duplicate criterion ids', () => {
    expectInvalid(minimal.replace('  - it works', '  - {id: A, description: one}\n  - {id: A, description: two}'), /duplicate acceptance criterion id 'A'/);
  });

  it('rejects path traversal', () => {
    expectInvalid(`${minimal}\nrequired_tests: [../outside_test.dart]\n`, /must be workspace-relative/);
    expectInvalid(`${minimal}\nprotected_paths: [/etc]\n`, /must be workspace-relative/);
  });

  it('rejects contracts where no criterion is required', () => {
    expectInvalid(minimal.replace('  - it works', '  - {description: optional, required: false}'), /at least one acceptance criterion must be required/);
  });

  it('parses gate references', () => {
    expect(parseGateRef('opengrep')).toEqual({ gate: 'opengrep' });
    expect(parseGateRef('opengrep.domain_flutter')).toEqual({ gate: 'opengrep', rule: 'domain_flutter' });
    expect(parseGateRef('architecture.rules.mvvm')).toEqual({ gate: 'architecture', rule: 'rules.mvvm' });
  });
});
