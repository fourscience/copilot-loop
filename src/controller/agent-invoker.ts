import { buildContextPacket, buildPrompt, type FileExcerpt, type RepositoryInstruction } from '../agents/agent-context';
import type { OutputTypes } from '../agents/agent-output';
import type { AgentRegistry } from '../agents/agent-registry';
import { AgentRunner, type AgentRunResult } from '../agents/agent-runner';
import type { ToolContext } from '../agents/agent-tools';
import type { CopilotClient, ModelInfo } from '../copilot/copilot-client';
import type { Clock, Logger } from '../core/ports';
import type { Diagnostic } from '../gates/gate-types';
import type { AgentId, AgentRunSummary, Assignment, LoopRecord } from '../persistence/models';
import type { Repository } from '../workspace/repository';
import { summariseGate } from './iteration';

export interface InvokerDependencies {
  client: CopilotClient;
  agents: AgentRegistry;
  repository: Repository;
  clock: Clock;
  logger: Logger;
  toolContext: Omit<ToolContext, 'signal' | 'onWrite' | 'validationBudget'>;
  instructions: () => Promise<RepositoryInstruction[]>;
  protectedPaths: readonly string[];
  modelPreferences: Partial<Record<AgentId, string>>;
  /** Called before the model request starts (UI: current agent/model). */
  onAgentStart?: (agent: AgentId, model: ModelInfo) => void;
  onText?: (agent: AgentId, fragment: string) => void;
}

export interface InvocationResult<K extends keyof OutputTypes> {
  result: AgentRunResult<K>;
  summary: AgentRunSummary;
  model: ModelInfo;
}

const MAX_EXCERPT_FILES = 6;
const EXCERPT_RADIUS = 15;
/** Default conversation budget when neither the task nor the model says otherwise. */
const DEFAULT_MAX_INPUT_TOKENS = 64_000;

/** Reads small windows of the files referenced by diagnostics (never whole repositories). */
export async function collectExcerpts(repository: Repository, diagnostics: readonly Diagnostic[], extraFiles: readonly string[] = []): Promise<FileExcerpt[]> {
  const byFile = new Map<string, number[]>();
  for (const d of diagnostics) {
    if (!d.file) continue;
    const lines = byFile.get(d.file) ?? [];
    if (d.line) lines.push(d.line);
    byFile.set(d.file, lines);
  }
  for (const f of extraFiles) if (!byFile.has(f)) byFile.set(f, []);
  const excerpts: FileExcerpt[] = [];
  for (const [file, lines] of [...byFile.entries()].slice(0, MAX_EXCERPT_FILES)) {
    let text: string;
    try {
      text = await repository.readFile(file);
    } catch {
      continue; // missing, protected-from-read or too large: the agent can use tools instead
    }
    const all = text.split(/\r?\n/);
    const windows = lines.length ? lines.map((l) => [Math.max(1, l - EXCERPT_RADIUS), Math.min(all.length, l + EXCERPT_RADIUS)] as const) : [[1, Math.min(all.length, 80)] as const];
    windows.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of windows) {
      const last = merged.at(-1);
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    for (const [s, e] of merged.slice(0, 3)) {
      excerpts.push({ path: file, startLine: s, text: all.slice(s - 1, e).map((l, i) => `${s + i}| ${l}`).join('\n') });
    }
  }
  return excerpts;
}

/**
 * Selects a model, assembles a focused context packet within budget, and runs
 * one agent. Pure orchestration glue: no state transitions happen here.
 */
export async function invokeAgent<K extends keyof OutputTypes>(
  deps: InvokerDependencies,
  record: LoopRecord,
  agentId: AgentId,
  options: { assignment?: Assignment; assignmentText: string; diagnostics?: readonly Diagnostic[]; extraFiles?: readonly string[]; signal?: AbortSignal; onWrite?: (path: string) => void },
): Promise<InvocationResult<K>> {
  const agent = deps.agents.get(agentId);
  const preferFamily = deps.modelPreferences[agentId];
  const model = await deps.client.selectModel({ ...agent.model, ...(preferFamily ? { preferFamily } : {}) }, options.signal);
  deps.onAgentStart?.(agentId, model);
  const maxInputTokens = Math.min(record.task.context.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS, Math.floor(model.maxInputTokens * 0.8) || DEFAULT_MAX_INPUT_TOKENS);
  const diagnostics = options.diagnostics ?? options.assignment?.diagnostics ?? [];
  const excerpts = await collectExcerpts(deps.repository, diagnostics, options.extraFiles);
  const packet = buildContextPacket({
    task: record.task,
    agent,
    iteration: record.iteration,
    ...(options.assignment ? { assignment: options.assignment } : {}),
    changedFiles: record.changedFiles,
    diagnostics,
    recentAgents: record.recentAgents,
    excerpts,
    criteria: record.criteria,
    ...(record.plan ? { plan: record.plan } : {}),
    gates: record.lastGateResults.map(summariseGate),
    ...(record.lastReview ? { review: record.lastReview } : {}),
    protectedPaths: deps.protectedPaths,
    requirementRules: record.task.requirements.map((r) => `requirement ${r.name}: must satisfy ${r.gates.join(', ')}`),
  });
  const prompt = buildPrompt({ agent, task: record.task, packet, instructions: await deps.instructions(), assignmentText: options.assignmentText, maxInputTokens });
  deps.logger.info(`Agent ${agentId} starting on ${model.id}`, { iteration: record.iteration, estimatedPromptTokens: prompt.budget.estimatedInputTokens, diagnostics: prompt.budget.diagnostics, files: prompt.budget.files, trimmed: prompt.budget.trimmed });

  const startedAt = deps.clock.now().toISOString();
  const runner = new AgentRunner(deps.client, deps.logger);
  const result = await runner.run<K>({
    agent,
    model,
    system: prompt.system,
    user: prompt.user,
    toolContext: { ...deps.toolContext, ...(options.signal ? { signal: options.signal } : {}), onWrite: options.onWrite ?? (() => undefined), validationBudget: { remaining: 3 } },
    maxTurns: record.task.limits.maxAgentTurns,
    maxInputTokens,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(deps.onText ? { onText: (f: string) => deps.onText?.(agentId, f) } : {}),
  });
  const output = result.output as { summary?: unknown } | undefined;
  const summary: AgentRunSummary = {
    agent: agentId,
    model: model.id,
    startedAt,
    finishedAt: deps.clock.now().toISOString(),
    outcome: result.outcome,
    summary: typeof output?.summary === 'string' ? output.summary : (result.outputError ?? result.finalText.slice(0, 500)),
    turns: result.turns,
    toolCalls: result.toolCalls,
    estimatedInputTokens: result.estimatedInputTokens,
    estimatedOutputTokens: result.estimatedOutputTokens,
    changedFiles: result.writes,
    ...(result.outputError ? { error: result.outputError } : {}),
  };
  deps.logger.info(`Agent ${agentId} finished: ${result.outcome}`, { turns: result.turns, toolCalls: result.toolCalls, writes: result.writes.length });
  return { result, summary, model };
}
