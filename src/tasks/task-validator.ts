import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { LoopError } from '../core/errors';
import {
  DEFAULT_LIMITS,
  parseGateRef,
  type AcceptanceCriterion,
  type RequirementMapping,
  type TaskContract,
} from './task-schema';

/** Raw (snake_case) shape produced by the YAML parser after schema validation. */
interface RawTask {
  id: string;
  title: string;
  goal: string;
  constraints?: string[];
  acceptance: (string | { id?: string; description: string; required?: boolean; evidence?: { tests?: string[]; gates?: string[] } })[];
  required_tests?: string[];
  gates: string[];
  requirements?: Record<string, { description?: string; gates: string[] }>;
  limits?: Partial<Record<'max_iterations' | 'max_same_failure' | 'max_agent_turns' | 'max_no_progress' | 'max_agent_runs' | 'max_review_rejections', number>>;
  git?: { checkpoints?: boolean };
  context?: { max_input_tokens?: number; relevant_paths?: string[] };
  protected_paths?: string[];
}

export class TaskValidator {
  private readonly validateFn: ValidateFunction;

  constructor(schema: object) {
    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
    this.validateFn = ajv.compile(schema);
  }

  /**
   * Validates raw parsed YAML against the JSON schema and semantic rules and
   * returns a normalised TaskContract. Throws TASK_INVALID with every problem.
   *
   * @param knownGateIds when provided, every referenced gate must exist.
   */
  validate(raw: unknown, knownGateIds?: ReadonlySet<string>): TaskContract {
    if (!this.validateFn(raw)) {
      throw new LoopError('TASK_INVALID', `Task contract does not match schema:\n${formatAjvErrors(this.validateFn.errors ?? [])}`, {
        errors: (this.validateFn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`),
      });
    }
    const task = normalise(raw as RawTask);
    const problems = semanticProblems(task, knownGateIds);
    if (problems.length > 0) {
      throw new LoopError('TASK_INVALID', `Task contract is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`, { errors: problems });
    }
    return task;
  }
}

function formatAjvErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => {
      const where = e.instancePath || '(root)';
      const extra = e.keyword === 'additionalProperties' ? ` '${String((e.params as { additionalProperty?: string }).additionalProperty)}'` : '';
      return `  - ${where}: ${e.message ?? 'invalid'}${extra}`;
    })
    .join('\n');
}

function normalise(raw: RawTask): TaskContract {
  const acceptance: AcceptanceCriterion[] = raw.acceptance.map((item, index) => {
    const fallbackId = `AC-${String(index + 1).padStart(3, '0')}`;
    if (typeof item === 'string') {
      return { id: fallbackId, description: item.trim(), required: true, evidence: { tests: [], gates: [] } };
    }
    return {
      id: item.id ?? fallbackId,
      description: item.description.trim(),
      required: item.required ?? true,
      evidence: { tests: item.evidence?.tests ?? [], gates: item.evidence?.gates ?? [] },
    };
  });
  const requirements: RequirementMapping[] = Object.entries(raw.requirements ?? {}).map(([name, value]) => ({
    name,
    ...(value.description !== undefined ? { description: value.description } : {}),
    gates: value.gates,
  }));
  const limits = raw.limits ?? {};
  return {
    id: raw.id,
    title: raw.title.trim(),
    goal: raw.goal.trim(),
    constraints: raw.constraints ?? [],
    acceptance,
    requiredTests: raw.required_tests ?? [],
    gates: raw.gates,
    requirements,
    limits: {
      maxIterations: limits.max_iterations ?? DEFAULT_LIMITS.maxIterations,
      maxSameFailure: limits.max_same_failure ?? DEFAULT_LIMITS.maxSameFailure,
      maxAgentTurns: limits.max_agent_turns ?? DEFAULT_LIMITS.maxAgentTurns,
      maxNoProgress: limits.max_no_progress ?? DEFAULT_LIMITS.maxNoProgress,
      maxAgentRuns: limits.max_agent_runs ?? DEFAULT_LIMITS.maxAgentRuns,
      maxReviewRejections: limits.max_review_rejections ?? DEFAULT_LIMITS.maxReviewRejections,
    },
    git: { checkpoints: raw.git?.checkpoints ?? false },
    context: {
      ...(raw.context?.max_input_tokens !== undefined ? { maxInputTokens: raw.context.max_input_tokens } : {}),
      relevantPaths: raw.context?.relevant_paths ?? [],
    },
    protectedPaths: raw.protected_paths ?? [],
  };
}

function isUnsafeRelativePath(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..');
}

function semanticProblems(task: TaskContract, knownGateIds?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const taskGates = new Set(task.gates);

  const ids = new Set<string>();
  for (const criterion of task.acceptance) {
    if (ids.has(criterion.id)) {
      problems.push(`duplicate acceptance criterion id '${criterion.id}'`);
    }
    ids.add(criterion.id);
    for (const ref of criterion.evidence.gates) {
      if (!taskGates.has(parseGateRef(ref).gate)) {
        problems.push(`acceptance '${criterion.id}' references gate '${ref}' which is not listed in 'gates'`);
      }
    }
    for (const test of criterion.evidence.tests) {
      if (isUnsafeRelativePath(test)) {
        problems.push(`acceptance '${criterion.id}' test path '${test}' must be workspace-relative`);
      }
    }
  }
  if (!task.acceptance.some((c) => c.required)) {
    problems.push('at least one acceptance criterion must be required');
  }
  for (const requirement of task.requirements) {
    for (const ref of requirement.gates) {
      if (!taskGates.has(parseGateRef(ref).gate)) {
        problems.push(`requirement '${requirement.name}' references gate '${ref}' which is not listed in 'gates'`);
      }
    }
  }
  for (const p of [...task.requiredTests, ...task.context.relevantPaths, ...task.protectedPaths]) {
    if (isUnsafeRelativePath(p)) {
      problems.push(`path '${p}' must be workspace-relative and must not contain '..'`);
    }
  }
  if (knownGateIds) {
    for (const gate of task.gates) {
      if (!knownGateIds.has(gate)) {
        problems.push(`gate '${gate}' is not defined (known gates: ${[...knownGateIds].sort().join(', ') || 'none'})`);
      }
    }
  }
  return problems;
}
