import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeTool, toolsFor, TOOL_DEFINITIONS, type ToolContext } from '../src/agents/agent-tools';
import { ALL_TOOL_NAMES } from '../src/agents/agent-registry';
import { nullLogger } from '../src/core/ports';
import { GateRegistry } from '../src/gates/gate-registry';
import { DefaultGateRunner } from '../src/gates/gate-runner';
import { DEFAULT_PROTECTED_PATHS, PathPolicy } from '../src/workspace/files';
import { GitCli } from '../src/workspace/git';
import { NodeProcessRunner } from '../src/workspace/process';
import { NodeRepository } from '../src/workspace/repository';
import { FakeClock, nodeGate, tempDir } from './helpers';

async function setup(useGit: boolean): Promise<ToolContext> {
  const root = await tempDir();
  await fs.mkdir(path.join(root, 'lib/features/auth/domain'), { recursive: true });
  await fs.mkdir(path.join(root, 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'lib/features/auth/domain/session.dart'), "import 'package:flutter/material.dart';\n\nclass Session {\n  Session();\n  Future<void> refreshToken() async {}\n}\n");
  await fs.writeFile(path.join(root, 'lib/main.dart'), "void main() {\n  final s = Session();\n  s.refreshToken();\n}\n");
  await fs.writeFile(path.join(root, 'test/a_test.dart'), 'void main() {}\n');
  await fs.mkdir(path.join(root, '.copilot-loop'), { recursive: true });
  await fs.writeFile(path.join(root, '.copilot-loop/state.json'), '{"secret":"Session"}');
  if (useGit) {
    execFileSync('git', ['init', '-q'], { cwd: root });
  }
  const processes = new NodeProcessRunner();
  const policy = new PathPolicy(root, DEFAULT_PROTECTED_PATHS);
  const registry = new GateRegistry();
  registry.register(nodeGate('unit', "console.log(JSON.stringify({message: 'args=' + process.argv.slice(1).join(' '), severity: 'info'}))", { acceptsPathArgument: true }));
  return {
    repository: new NodeRepository(root, policy, processes),
    git: new GitCli(root, processes),
    gates: new DefaultGateRunner(registry, processes, new FakeClock(), nullLogger),
    gateRegistry: registry,
    policy,
    allowedGates: ['unit'],
    workspaceRoot: root,
    logger: nullLogger,
    onWrite: () => undefined,
    validationBudget: { remaining: 2 },
  };
}

const all = toolsFor(ALL_TOOL_NAMES);
const call = (ctx: ToolContext, name: string, input: Record<string, unknown>) => executeTool(name, input, all, ctx);

describe.each([true, false])('repository tools (git=%s)', (useGit) => {
  it('searches, finds symbols and references, and lists files — excluding loop state', async () => {
    const ctx = await setup(useGit);
    const search = await call(ctx, 'repository_search', { query: 'package:flutter', glob: 'lib/**' });
    expect(search.content).toContain('lib/features/auth/domain/session.dart:1:');
    const def = await call(ctx, 'repository_find_symbol', { name: 'Session' });
    expect(def.content).toContain('session.dart:3: class Session');
    expect(def.content).not.toContain('main.dart');
    const method = await call(ctx, 'repository_find_symbol', { name: 'refreshToken' });
    expect(method.content).toContain('session.dart:5');
    const refs = await call(ctx, 'repository_find_references', { name: 'Session' });
    expect(refs.content).toContain('lib/main.dart:2');
    expect(refs.content).not.toContain('.copilot-loop');
    const files = await call(ctx, 'workspace_list_files', { glob: '**/*.dart' });
    expect(files.content.split('\n').sort()).toEqual(['lib/features/auth/domain/session.dart', 'lib/main.dart', 'test/a_test.dart']);
  });
});

describe('tool safety', () => {
  it('validates inputs against the tool schema', async () => {
    const ctx = await setup(false);
    const r = await call(ctx, 'repository_read_file', { path: 'lib/main.dart', extra: 1 });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Invalid input/);
  });

  it('reads files with line numbers and ranges', async () => {
    const ctx = await setup(false);
    const r = await call(ctx, 'repository_read_file', { path: 'lib/main.dart', startLine: 2, endLine: 3 });
    expect(r.content).toContain('    2|   final s = Session();');
    expect(r.content).not.toContain('void main');
  });

  it('only runs gates of the task, within the validation budget, and never passes option-like paths', async () => {
    const ctx = await setup(false);
    expect((await call(ctx, 'validation_run_gate', { gateId: 'other' })).content).toMatch(/not part of this task/);
    const test = await call(ctx, 'validation_run_test', { path: 'test/a_test.dart' });
    expect(test.content).toContain('args=test/a_test.dart');
    await fs.writeFile(path.join(ctx.workspaceRoot, '--update-goldens'), '');
    expect((await call(ctx, 'validation_run_test', { path: '--update-goldens' })).content).toMatch(/Invalid test path/);
    await call(ctx, 'validation_run_gate', { gateId: 'unit' });
    expect((await call(ctx, 'validation_run_gate', { gateId: 'unit' })).content).toMatch(/budget/);
  });

  it('replace_in_file requires a unique match', async () => {
    const ctx = await setup(false);
    expect((await call(ctx, 'workspace_replace_in_file', { path: 'lib/main.dart', oldText: 'nope', newText: 'x' })).content).toMatch(/not found/);
    await fs.writeFile(path.join(ctx.workspaceRoot, 'lib/dup.dart'), 'a\na\n');
    expect((await call(ctx, 'workspace_replace_in_file', { path: 'lib/dup.dart', oldText: 'a', newText: 'b' })).content).toMatch(/more than once/);
  });

  it('declares an explicit JSON schema for every tool', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.name).toMatch(/^[a-z_]+$/);
    }
  });
});
