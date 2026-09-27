/** Typed model of a validated task contract (see schemas/task.schema.json). */

export interface AcceptanceEvidenceSpec {
  /** Test files that must exist and pass for the criterion to be verified. */
  tests: string[];
  /** Gate references (`gate` or `gate.rule`) that must pass. */
  gates: string[];
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  required: boolean;
  evidence: AcceptanceEvidenceSpec;
}

export interface RequirementMapping {
  name: string;
  description?: string;
  gates: string[];
}

export interface TaskLimits {
  maxIterations: number;
  maxSameFailure: number;
  /** Max model round-trips (tool-calling turns) within one agent run. */
  maxAgentTurns: number;
  /** Consecutive validations without measurable progress before escalating. */
  maxNoProgress: number;
  /** Hard ceiling on the total number of agent invocations for the task. */
  maxAgentRuns: number;
  /** Reviewer FAIL verdicts tolerated before the loop blocks. */
  maxReviewRejections: number;
}

export interface TaskContract {
  id: string;
  title: string;
  goal: string;
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  requiredTests: string[];
  gates: string[];
  requirements: RequirementMapping[];
  limits: TaskLimits;
  git: { checkpoints: boolean };
  context: { maxInputTokens?: number; relevantPaths: string[] };
  protectedPaths: string[];
}

export const DEFAULT_LIMITS: TaskLimits = {
  maxIterations: 30,
  maxSameFailure: 3,
  maxAgentTurns: 30,
  maxNoProgress: 2,
  maxAgentRuns: 120,
  maxReviewRejections: 3,
};

/** A gate reference is either `gateId` or `gateId.ruleId`. */
export interface GateRef {
  gate: string;
  rule?: string;
}

export function parseGateRef(ref: string): GateRef {
  const dot = ref.indexOf('.');
  if (dot < 0) {
    return { gate: ref };
  }
  return { gate: ref.slice(0, dot), rule: ref.slice(dot + 1) };
}
