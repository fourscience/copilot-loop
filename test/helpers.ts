import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Clock } from '../src/core/ports';
import { parseGateDefinition } from '../src/gates/gate-registry';
import type { GateDefinition } from '../src/gates/gate-types';
import { TaskValidator } from '../src/tasks/task-validator';
import taskSchema from '../schemas/task.schema.json';

export const REPO_ROOT = path.resolve(__dirname, '..');

export function newValidator(): TaskValidator {
  return new TaskValidator(taskSchema);
}

export async function tempDir(prefix = 'copilot-loop-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export class FakeClock implements Clock {
  private t: number;
  constructor(start = Date.parse('2026-01-01T00:00:00Z')) {
    this.t = start;
  }
  now(): Date {
    this.t += 1000;
    return new Date(this.t);
  }
}

export function nodeGate(id: string, script: string, overrides: Partial<GateDefinition> = {}): GateDefinition {
  return {
    ...parseGateDefinition({ id, name: id, category: 'test', command: 'node', args: ['-e', script], parser: 'generic' }, 'test'),
    ...overrides,
  };
}
