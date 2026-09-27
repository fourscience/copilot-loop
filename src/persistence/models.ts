import type { ErrorCode } from '../core/errors';
import type { FingerprintRecord, ProgressSample } from '../diagnosis/failure-analyzer';
import type { Diagnostic, DiagnosticCategory, GateMetrics, GateStatus } from '../gates/gate-types';
import type { TaskContract } from '../tasks/task-schema';

export const LOOP_STATES = ['INTAKE', 'PLAN', 'IMPLEMENT', 'VALIDATE', 'DIAGNOSE', 'FIX', 'REVIEW', 'DONE', 'BLOCKED', 'PAUSED', 'STOPPED'] as const;
export type LoopState = (typeof LOOP_STATES)[number];

export const AGENT_IDS = ['architect', 'implementer', 'debugger', 'test-engineer', 'architecture-fixer', 'security', 'refactoring', 'diagnoser', 'reviewer'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Agents that are allowed to modify the workspace when routed to. */
export const SPECIALIST_AGENTS = ['implementer', 'debugger', 'test-engineer', 'architecture-fixer', 'security', 'refactoring'] as const satisfies readonly AgentId[];
export type SpecialistAgentId = (typeof SPECIALIST_AGENTS)[number];

export function isSpecialist(agent: string): agent is SpecialistAgentId {
  return (SPECIALIST_AGENTS as readonly string[]).includes(agent);
}

export type CriterionStatus = 'unknown' | 'in_progress' | 'verified' | 'failed' | 'blocked';

export interface CriterionRecord {
  id: string;
  description: string;
  required: boolean;
  status: CriterionStatus;
  evidence: string[];
  /** Who last determined the status. */
  source?: 'controller' | 'review';
  notes?: string;
}

export interface RequirementStatus {
  name: string;
  gates: string[];
  satisfied: boolean;
  unmet: string[];
}

export interface Assignment {
  agent: SpecialistAgentId;
  category: DiagnosticCategory | 'review';
  diagnostics: Diagnostic[];
  reason: string;
}

export interface PlanRecord {
  summary: string;
  affectedFiles: string[];
  steps: string[];
  tests: string[];
  risks: string[];
  criteria: { id: string; approach: string; evidence: string[] }[];
}

export interface ReviewRecord {
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
  criteria: { id: string; status: 'met' | 'not_met'; evidence: string[] }[];
  findings: { category: DiagnosticCategory; message: string; file?: string; line?: number }[];
  at: string;
}

export interface GateRunSummary {
  gateId: string;
  status: GateStatus;
  exitCode: number;
  diagnosticCount: number;
  durationMs: number;
  metrics: GateMetrics;
  error?: string;
}

export type AgentOutcome = 'completed' | 'invalid_output' | 'turn_limit' | 'budget_exhausted' | 'failed' | 'cancelled';

export interface AgentRunSummary {
  agent: AgentId;
  model?: string;
  startedAt: string;
  finishedAt: string;
  outcome: AgentOutcome;
  summary: string;
  turns: number;
  toolCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  changedFiles: string[];
  error?: string;
}

export interface BlockedReason {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface TransitionRecord {
  from: LoopState;
  to: LoopState;
  at: string;
  reason: string;
}

export const RECORD_SCHEMA_VERSION = 1;

/** The complete persisted loop state (`.copilot-loop/state.json`). */
export interface LoopRecord {
  schemaVersion: number;
  runId: string;
  task: TaskContract;
  taskPath: string;
  taskHash: string;
  state: LoopState;
  /** Set while PAUSED: the state to resume into. */
  pausedFrom?: LoopState;
  blocked?: BlockedReason;
  /** Number of modification iterations (IMPLEMENT + FIX steps) started. */
  iteration: number;
  agentRuns: number;
  reviewRejections: number;
  /** Escalation level for no-progress handling (0 = normal routing). */
  escalation: number;
  historySequence: number;
  plan?: PlanRecord;
  criteria: CriterionRecord[];
  requirements: RequirementStatus[];
  lastGates: GateRunSummary[];
  lastFailures: Diagnostic[];
  /** Workspace fingerprint captured at the last validation. */
  validatedWorkspace?: string;
  pending: Assignment[];
  fingerprints: Record<string, FingerprintRecord>;
  progress: ProgressSample[];
  changedFiles: string[];
  recentAgents: AgentRunSummary[];
  lastReview?: ReviewRecord;
  currentAgent?: AgentId;
  currentModel?: string;
  checkpoints: { iteration: number; ref: string; at: string }[];
  transitions: TransitionRecord[];
  createdAt: string;
  updatedAt: string;
}

export type IterationResult = 'continue' | 'done' | 'blocked' | 'paused' | 'stopped';

/** One observable step, written to `.copilot-loop/history/NNNN.json`. */
export interface IterationRecord {
  task: string;
  runId: string;
  sequence: number;
  iteration: number;
  phase: LoopState;
  agent?: AgentId;
  model?: string;
  startedAt: string;
  finishedAt: string;
  changedFiles: string[];
  gates: GateRunSummary[];
  diagnostics: Diagnostic[];
  agentRun?: AgentRunSummary;
  /** Full transcript of the agent run (messages as plain text), bounded. */
  transcript?: { role: string; text: string }[];
  /** Raw gate output tails for debugging. */
  gateOutput?: { gateId: string; stdout: string; stderr: string }[];
  notes: string[];
  result: IterationResult;
  nextState: LoopState;
}
