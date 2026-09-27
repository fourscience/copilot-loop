import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RepositoryInstruction } from './agents/agent-context';
import { AgentRegistry } from './agents/agent-registry';
import type { CopilotClient } from './copilot/copilot-client';
import type { InvokerDependencies } from './controller/agent-invoker';
import { LoopController, type ControllerDependencies, type LoopEvents } from './controller/loop-controller';
import { LoopError } from './core/errors';
import type { Clock, Logger } from './core/ports';
import { systemClock } from './core/ports';
import { truncate } from './core/text';
import { GateRegistry, type GateDefinitionSource } from './gates/gate-registry';
import { DEFAULT_GATE_TIMEOUT_MS, DefaultGateRunner } from './gates/gate-runner';
import type { AgentId, LoopRecord } from './persistence/models';
import { FileRunLock, JsonStateStore } from './persistence/state-store';
import { TaskLoader } from './tasks/task-loader';
import { TaskValidator } from './tasks/task-validator';
import { DEFAULT_PROTECTED_PATHS, PathPolicy, buildProtectedPaths } from './workspace/files';
import { GitCli, NoGit, type Git } from './workspace/git';
import { NodeProcessRunner, type ProcessRunner } from './workspace/process';
import { NodeRepository } from './workspace/repository';

/** Workspace directory holding loop state, history and optional workspace gate overrides. */
export const STATE_DIR = '.copilot-loop';

/** Repository instruction files, in the order they are presented (all below controller policy). */
export const INSTRUCTION_FILES = ['.github/copilot-instructions.md', 'AGENTS.md', 'agent.md', 'CLAUDE.md', '.github/architecture/README.md'];
const MAX_INSTRUCTION_CHARS = 6000;
const MAX_TOTAL_INSTRUCTION_CHARS = 16000;

export interface ServiceOptions {
  workspaceRoot: string;
  /** Directory containing the bundled agents/, gates/ and schemas/. */
  extensionRoot: string;
  client: CopilotClient;
  logger: Logger;
  events?: LoopEvents;
  modelPreferences?: Partial<Record<AgentId, string>>;
  gateTimeoutMs?: number;
  clock?: Clock;
  processes?: ProcessRunner;
}

export interface LoopServices {
  controller: LoopController;
  taskLoader: TaskLoader;
  gateRegistry: GateRegistry;
  agents: AgentRegistry;
  store: JsonStateStore;
  git: Git;
  policy: PathPolicy;
}

function directorySource(dir: string): GateDefinitionSource {
  return {
    async load() {
      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      } catch {
        return [];
      }
      return Promise.all(
        files.map(async (f) => {
          const file = path.join(dir, f);
          try {
            return { source: file, raw: JSON.parse(await fs.readFile(file, 'utf8')) as unknown };
          } catch (error) {
            throw new LoopError('CONFIGURATION_ERROR', `Gate definition ${file} is not valid JSON: ${(error as Error).message}`);
          }
        }),
      );
    },
  };
}

async function loadAgents(dir: string): Promise<AgentRegistry> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.agent.md')).sort();
  return AgentRegistry.fromFiles(await Promise.all(files.map(async (f) => ({ source: path.join(dir, f), text: await fs.readFile(path.join(dir, f), 'utf8') }))));
}

/** Loads repository instruction files as low-precedence guidance (never policy). */
export async function loadRepositoryInstructions(root: string, extra: readonly string[] = []): Promise<RepositoryInstruction[]> {
  const out: RepositoryInstruction[] = [];
  let total = 0;
  const candidates = [...INSTRUCTION_FILES, ...extra];
  try {
    const dir = path.join(root, '.github/instructions');
    for (const f of (await fs.readdir(dir)).filter((n) => n.endsWith('.instructions.md')).sort()) candidates.push(`.github/instructions/${f}`);
  } catch {
    /* optional */
  }
  for (const rel of candidates) {
    if (total >= MAX_TOTAL_INSTRUCTION_CHARS) break;
    try {
      const text = await fs.readFile(path.join(root, rel), 'utf8');
      const clipped = truncate(text, Math.min(MAX_INSTRUCTION_CHARS, MAX_TOTAL_INSTRUCTION_CHARS - total));
      total += clipped.length;
      out.push({ source: rel, text: clipped });
    } catch {
      /* file absent */
    }
  }
  return out;
}

/**
 * Composition root. Everything here is framework-independent; the VS Code
 * extension passes in its Copilot client, logger and UI event sinks.
 */
export async function createServices(options: ServiceOptions): Promise<LoopServices> {
  const root = options.workspaceRoot;
  const clock = options.clock ?? systemClock;
  const logger = options.logger;
  const processes = options.processes ?? new NodeProcessRunner();

  const gateRegistry = await GateRegistry.fromSources([directorySource(path.join(options.extensionRoot, 'gates')), directorySource(path.join(root, STATE_DIR, 'gates'))]);
  const agents = await loadAgents(path.join(options.extensionRoot, 'agents'));
  agents.assertComplete();
  const schema = JSON.parse(await fs.readFile(path.join(options.extensionRoot, 'schemas', 'task.schema.json'), 'utf8')) as object;
  const validator = new TaskValidator(schema);
  const taskLoader = new TaskLoader({ readText: (p) => fs.readFile(path.resolve(root, p), 'utf8') }, validator);

  // Protected paths follow the active task: defaults + task additions + task file + gate config files.
  let protectedFor: { runId: string; list: readonly string[] } | undefined;
  const protectedPathsFor = (record: LoopRecord | undefined): readonly string[] => {
    if (!record) return DEFAULT_PROTECTED_PATHS;
    if (protectedFor?.runId !== record.runId) {
      const gateArgs = record.task.gates.flatMap((g) => gateRegistry.get(g)?.args ?? []);
      protectedFor = { runId: record.runId, list: buildProtectedPaths({ taskPath: record.taskPath, taskProtected: record.task.protectedPaths, gateArgs, root }) };
    }
    return protectedFor.list;
  };
  let activeRecord: LoopRecord | undefined;
  const policy = new PathPolicy(root, () => protectedPathsFor(activeRecord));

  const repository = new NodeRepository(root, policy, processes);
  const gitCli = new GitCli(root, processes);
  const git: Git = (await gitCli.isRepository())
    ? gitCli
    : new NoGit(async () => {
        const { files } = await repository.listFiles({ max: 5000 });
        const stats = await Promise.all(files.map(async (f) => fs.stat(path.join(root, f)).then((s) => ({ path: f, size: s.size, mtimeMs: s.mtimeMs })).catch(() => undefined)));
        return stats.filter((s): s is { path: string; size: number; mtimeMs: number } => s !== undefined);
      });
  const gates = new DefaultGateRunner(gateRegistry, processes, clock, logger, options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS);
  const store = new JsonStateStore(path.join(root, STATE_DIR));

  const invoker: InvokerDependencies = {
    client: options.client,
    agents,
    repository,
    clock,
    logger,
    toolContext: { repository, git, gates, gateRegistry, policy, workspaceRoot: root, logger },
    instructions: () => loadRepositoryInstructions(root),
    protectedPaths: (record) => protectedPathsFor(record),
    modelPreferences: options.modelPreferences ?? {},
  };
  const deps: ControllerDependencies = {
    workspaceRoot: root,
    client: options.client,
    agents,
    gates,
    repository,
    git,
    clock,
    logger,
    invoker,
    store,
    lock: new FileRunLock(path.join(root, STATE_DIR, 'run.lock')),
    workspaceAvailable: async () => {
      try {
        return (await fs.stat(root)).isDirectory();
      } catch {
        return false;
      }
    },
    events: {
      onRecord: (record) => {
        activeRecord = record;
        options.events?.onRecord?.(record);
      },
    },
  };
  const controller = new LoopController(deps);
  activeRecord = await controller.load();
  return { controller, taskLoader, gateRegistry, agents, store, git, policy };
}
