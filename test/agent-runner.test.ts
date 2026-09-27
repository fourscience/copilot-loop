import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/agents/agent-runner';
import type { ToolContext } from '../src/agents/agent-tools';
import { MOCK_MODELS, MockCopilotClient } from '../src/copilot/mock-copilot-client';
import type { AgentResponse } from '../src/copilot/copilot-client';
import { nullLogger } from '../src/core/ports';
import { GateRegistry } from '../src/gates/gate-registry';
import { DefaultGateRunner } from '../src/gates/gate-runner';
import { DEFAULT_PROTECTED_PATHS, PathPolicy } from '../src/workspace/files';
import { NoGit } from '../src/workspace/git';
import { NodeProcessRunner } from '../src/workspace/process';
import { NodeRepository } from '../src/workspace/repository';
import { FakeClock, bundledAgents, tempDir } from './helpers';

async function toolContext(root: string): Promise<ToolContext> {
  const processes = new NodeProcessRunner();
  const policy = new PathPolicy(root, DEFAULT_PROTECTED_PATHS);
  const registry = new GateRegistry();
  return {
    repository: new NodeRepository(root, policy, processes),
    git: new NoGit(async () => []),
    gates: new DefaultGateRunner(registry, processes, new FakeClock(), nullLogger),
    gateRegistry: registry,
    policy,
    allowedGates: [],
    workspaceRoot: root,
    logger: nullLogger,
    onWrite: () => undefined,
    validationBudget: { remaining: 3 },
  };
}

const CHANGE_JSON = '```json\n{"summary":"done","filesChanged":["lib/a.dart"],"unresolved":[]}\n```';

describe('agent runner', () => {
  it('executes tool calls, feeds results back and parses the final output', async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, 'lib'));
    await fs.writeFile(path.join(root, 'lib/a.dart'), 'void main() {}\n');
    const responses: AgentResponse[] = [
      { text: '', toolCalls: [{ callId: 'c1', name: 'repository_read_file', input: { path: 'lib/a.dart' } }] },
      { text: '', toolCalls: [{ callId: 'c2', name: 'workspace_replace_in_file', input: { path: 'lib/a.dart', oldText: 'void main() {}', newText: 'void main() { print(1); }' } }] },
      { text: `Finished. ${CHANGE_JSON}`, toolCalls: [] },
    ];
    const client = new MockCopilotClient((_req, i) => responses[i] as AgentResponse);
    const agent = (await bundledAgents()).get('implementer');
    const result = await new AgentRunner(client, nullLogger).run({ agent, model: MOCK_MODELS[0]!, system: 'S', user: 'U', toolContext: await toolContext(root), maxTurns: 10, maxInputTokens: 50000 });
    expect(result.outcome).toBe('completed');
    expect(result.output).toEqual({ summary: 'done', filesChanged: ['lib/a.dart'], unresolved: [] });
    expect(result.writes).toEqual(['lib/a.dart']);
    expect(await fs.readFile(path.join(root, 'lib/a.dart'), 'utf8')).toContain('print(1)');
    const second = client.requests[1]!;
    const toolResult = second.messages.at(-1)!.parts[0]!;
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.type === 'tool_result' && toolResult.content).toContain('void main');
    expect(client.maxConcurrent).toBe(1);
  });

  it('denies tools the agent does not own and writes to protected paths', async () => {
    const root = await tempDir();
    const responses: AgentResponse[] = [
      { text: '', toolCalls: [{ callId: 'c1', name: 'workspace_write_file', input: { path: 'x.dart', content: 'x' } }] },
      { text: '```json\n{"verdict":"PASS","reasons":[],"criteria":[]}\n```', toolCalls: [] },
    ];
    const client = new MockCopilotClient((_r, i) => responses[i] as AgentResponse);
    const reviewer = (await bundledAgents()).get('reviewer');
    const r = await new AgentRunner(client, nullLogger).run({ agent: reviewer, model: MOCK_MODELS[0]!, system: '', user: '', toolContext: await toolContext(root), maxTurns: 5, maxInputTokens: 50000 });
    const denied = client.requests[1]!.messages.at(-1)!.parts[0]!;
    expect(denied.type === 'tool_result' && denied.isError).toBe(true);
    expect(r.writes).toEqual([]);
    await expect(fs.stat(path.join(root, 'x.dart'))).rejects.toThrow();

    const writer = (await bundledAgents()).get('architecture-fixer');
    const attempts: AgentResponse[] = [
      { text: '', toolCalls: [
        { callId: 'a', name: 'workspace_write_file', input: { path: '.github/architecture/opengrep.yml', content: 'rules: []' } },
        { callId: 'b', name: 'workspace_write_file', input: { path: 'analysis_options.yaml', content: '' } },
        { callId: 'c', name: 'workspace_write_file', input: { path: '../escape.txt', content: '' } },
        { callId: 'd', name: 'workspace_write_file', input: { path: '.copilot-loop/state.json', content: '{}' } },
      ] },
      { text: CHANGE_JSON, toolCalls: [] },
    ];
    const client2 = new MockCopilotClient((_r, i) => attempts[i] as AgentResponse);
    const r2 = await new AgentRunner(client2, nullLogger).run({ agent: writer, model: MOCK_MODELS[0]!, system: '', user: '', toolContext: await toolContext(root), maxTurns: 5, maxInputTokens: 50000 });
    const results = client2.requests[1]!.messages.at(-1)!.parts;
    expect(results.every((p) => p.type === 'tool_result' && p.isError)).toBe(true);
    expect(r2.writes).toEqual([]);
  });

  it('asks once for a repair when the output is invalid, then gives up', async () => {
    const client = new MockCopilotClient(() => ({ text: 'I am done!', toolCalls: [] }));
    const agent = (await bundledAgents()).get('reviewer');
    const r = await new AgentRunner(client, nullLogger).run({ agent, model: MOCK_MODELS[0]!, system: '', user: '', toolContext: await toolContext(await tempDir()), maxTurns: 5, maxInputTokens: 50000 });
    expect(r.outcome).toBe('invalid_output');
    expect(client.requests).toHaveLength(2);
  });

  it('stops at the turn limit', async () => {
    const client = new MockCopilotClient(() => ({ text: '', toolCalls: [{ callId: 'x', name: 'git_status', input: {} }] }));
    const agent = (await bundledAgents()).get('debugger');
    const r = await new AgentRunner(client, nullLogger).run({ agent, model: MOCK_MODELS[0]!, system: '', user: '', toolContext: await toolContext(await tempDir()), maxTurns: 3, maxInputTokens: 50000 });
    expect(r.outcome).toBe('turn_limit');
    expect(client.requests).toHaveLength(3);
  });

  it('stops when the context budget is exhausted', async () => {
    const client = new MockCopilotClient(() => ({ text: '', toolCalls: [] }));
    const agent = (await bundledAgents()).get('debugger');
    const r = await new AgentRunner(client, nullLogger).run({ agent, model: MOCK_MODELS[0]!, system: 'x'.repeat(10000), user: '', toolContext: await toolContext(await tempDir()), maxTurns: 3, maxInputTokens: 100 });
    expect(r.outcome).toBe('budget_exhausted');
    expect(client.requests).toHaveLength(0);
  });

  it('propagates cancellation as USER_CANCELLED', async () => {
    const controller = new AbortController();
    const client = new MockCopilotClient(() => {
      controller.abort();
      return { text: '', toolCalls: [{ callId: 'x', name: 'git_status', input: {} }] };
    });
    const agent = (await bundledAgents()).get('debugger');
    await expect(new AgentRunner(client, nullLogger).run({ agent, model: MOCK_MODELS[0]!, system: '', user: '', toolContext: await toolContext(await tempDir()), maxTurns: 3, maxInputTokens: 50000, signal: controller.signal })).rejects.toMatchObject({ code: 'USER_CANCELLED' });
  });

  it('never lets tools read secret files or the loop state', async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, '.env'), 'API_KEY=supersecretvalue');
    const client = new MockCopilotClient((_r, i) => (i === 0 ? { text: '', toolCalls: [{ callId: 'a', name: 'repository_read_file', input: { path: '.env' } }, { callId: 'b', name: 'repository_read_file', input: { path: '.copilot-loop/state.json' } }] } : { text: CHANGE_JSON, toolCalls: [] }));
    const agent = (await bundledAgents()).get('debugger');
    await new AgentRunner(client, nullLogger).run({ agent, model: MOCK_MODELS[0]!, system: '', user: '', toolContext: await toolContext(root), maxTurns: 3, maxInputTokens: 50000 });
    const parts = client.requests[1]!.messages.at(-1)!.parts;
    expect(parts.every((p) => p.type === 'tool_result' && p.isError)).toBe(true);
    expect(JSON.stringify(client.requests)).not.toContain('supersecretvalue');
  });
});
