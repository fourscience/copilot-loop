import { parse as parseYaml } from 'yaml';
import { LoopError } from '../core/errors';
import type { CapabilityLevel, ModelRequirements } from '../copilot/copilot-client';
import { AGENT_IDS, type AgentId } from '../persistence/models';
import { OUTPUT_KINDS, type OutputKind } from './agent-output';

export const READ_TOOLS = ['repository_read_file', 'repository_search', 'repository_find_symbol', 'repository_find_references', 'workspace_list_files', 'git_status', 'git_diff'] as const;
export const VALIDATION_TOOLS = ['validation_run_gate', 'validation_run_test'] as const;
export const WRITE_TOOLS = ['workspace_write_file', 'workspace_replace_in_file'] as const;
export const ALL_TOOL_NAMES: readonly string[] = [...READ_TOOLS, ...VALIDATION_TOOLS, ...WRITE_TOOLS];

interface AgentPolicy {
  /** Upper bound on tools; agent files can only narrow this. */
  maxTools: readonly string[];
  output: OutputKind;
  writes: boolean;
}

const WRITER: AgentPolicy = { maxTools: [...READ_TOOLS, ...VALIDATION_TOOLS, ...WRITE_TOOLS], output: 'change', writes: true };

/**
 * Controller policy for each agent. This lives in code (not in the agent
 * markdown) so that no repository file or prompt can grant an agent more power.
 */
export const AGENT_POLICY: Readonly<Record<AgentId, AgentPolicy>> = {
  architect: { maxTools: READ_TOOLS, output: 'plan', writes: false },
  implementer: WRITER,
  debugger: WRITER,
  'test-engineer': WRITER,
  'architecture-fixer': WRITER,
  security: WRITER,
  refactoring: WRITER,
  diagnoser: { maxTools: READ_TOOLS, output: 'diagnosis', writes: false },
  reviewer: { maxTools: READ_TOOLS, output: 'review', writes: false },
};

export interface AgentDefinition {
  id: AgentId;
  name: string;
  description: string;
  tools: string[];
  writes: boolean;
  model: ModelRequirements;
  output: OutputKind;
  /** Role instructions (markdown body). */
  instructions: string;
  source: string;
}

const LEVELS: readonly CapabilityLevel[] = ['low', 'medium', 'high'];

function splitFrontMatter(text: string, source: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new LoopError('CONFIGURATION_ERROR', `Agent file ${source} must start with YAML front matter`);
  const meta: unknown = parseYaml(m[1] as string);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new LoopError('CONFIGURATION_ERROR', `Agent file ${source} has invalid front matter`);
  return { meta: meta as Record<string, unknown>, body: (m[2] as string).trim() };
}

export function parseAgentDefinition(text: string, source: string): AgentDefinition {
  const { meta, body } = splitFrontMatter(text, source);
  const fail = (msg: string): never => {
    throw new LoopError('CONFIGURATION_ERROR', `Agent file ${source}: ${msg}`);
  };
  const id = meta.id;
  if (typeof id !== 'string' || !(AGENT_IDS as readonly string[]).includes(id)) fail(`unknown agent id '${String(id)}'`);
  const agentId = id as AgentId;
  const policy = AGENT_POLICY[agentId];
  const tools = Array.isArray(meta.tools) ? meta.tools.map(String) : [];
  for (const tool of tools) {
    if (!ALL_TOOL_NAMES.includes(tool)) fail(`unknown tool '${tool}'`);
    if (!policy.maxTools.includes(tool)) fail(`tool '${tool}' is not permitted for agent '${agentId}' by controller policy`);
  }
  const output = meta.output ?? policy.output;
  if (typeof output !== 'string' || !(OUTPUT_KINDS as readonly string[]).includes(output) || output !== policy.output) fail(`output must be '${policy.output}'`);
  const model: ModelRequirements = {};
  const rawModel = (meta.model ?? {}) as Record<string, unknown>;
  for (const key of ['reasoning', 'coding', 'speed'] as const) {
    const v = rawModel[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !(LEVELS as readonly string[]).includes(v)) fail(`model.${key} must be low|medium|high`);
    model[key] = v as CapabilityLevel;
  }
  if (!body) fail('instructions body is empty');
  return {
    id: agentId,
    name: typeof meta.name === 'string' ? meta.name : agentId,
    description: typeof meta.description === 'string' ? meta.description : '',
    tools,
    writes: policy.writes,
    model,
    output: policy.output,
    instructions: body,
    source,
  };
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, AgentDefinition>();

  register(definition: AgentDefinition): void {
    this.agents.set(definition.id, definition);
  }

  get(id: AgentId): AgentDefinition {
    const agent = this.agents.get(id);
    if (!agent) throw new LoopError('CONFIGURATION_ERROR', `Agent '${id}' is not registered`);
    return agent;
  }

  has(id: AgentId): boolean {
    return this.agents.has(id);
  }

  all(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /** Ensures every agent the controller can route to exists. */
  assertComplete(): void {
    const missing = AGENT_IDS.filter((id) => !this.agents.has(id));
    if (missing.length > 0) throw new LoopError('CONFIGURATION_ERROR', `Missing agent definitions: ${missing.join(', ')}`);
  }

  static fromFiles(files: { source: string; text: string }[]): AgentRegistry {
    const registry = new AgentRegistry();
    for (const f of files) registry.register(parseAgentDefinition(f.text, f.source));
    return registry;
  }
}
