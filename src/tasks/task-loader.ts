import { parseDocument } from 'yaml';
import { LoopError } from '../core/errors';
import { sha256 } from '../core/text';
import type { TaskContract } from './task-schema';
import type { TaskValidator } from './task-validator';

export interface LoadedTask {
  task: TaskContract;
  /** Workspace-relative or absolute path the task was loaded from. */
  path: string;
  /** Hash of the raw file; used to detect edits to the task between sessions. */
  hash: string;
}

export interface TaskSource {
  readText(path: string): Promise<string>;
}

/** Parses YAML (with a real YAML parser) and validates it against the task schema. */
export function parseTask(text: string, validator: TaskValidator, knownGateIds?: ReadonlySet<string>): TaskContract {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true, strict: true });
  if (doc.errors.length > 0) {
    throw new LoopError('TASK_INVALID', `Task YAML could not be parsed:\n${doc.errors.map((e) => `  - ${e.message}`).join('\n')}`);
  }
  // Aliases/anchors are allowed but capped to avoid billion-laughs style expansion.
  const raw: unknown = doc.toJS({ maxAliasCount: 100 });
  return validator.validate(raw, knownGateIds);
}

export class TaskLoader {
  constructor(
    private readonly source: TaskSource,
    private readonly validator: TaskValidator,
  ) {}

  async load(path: string, knownGateIds?: ReadonlySet<string>): Promise<LoadedTask> {
    let text: string;
    try {
      text = await this.source.readText(path);
    } catch (error) {
      throw new LoopError('TASK_INVALID', `Task file '${path}' could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { task: parseTask(text, this.validator, knownGateIds), path, hash: sha256(text) };
  }
}
