import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServices, loadRepositoryInstructions } from '../src/bootstrap';
import { MockCopilotClient } from '../src/copilot/mock-copilot-client';
import { MemoryLogger } from '../src/core/ports';
import { CHANGE_JSON, PASS_JSON, PLAN_JSON, agentOf } from './harness';
import { REPO_ROOT, tempDir } from './helpers';

async function workspace(): Promise<string> {
  const root = await tempDir();
  await fs.mkdir(path.join(root, 'tasks'), { recursive: true });
  await fs.copyFile(path.join(REPO_ROOT, 'tasks/example.yaml'), path.join(root, 'tasks/example.yaml'));
  return root;
}

const client = () =>
  new MockCopilotClient((request) => {
    const agent = agentOf(request);
    if (agent === 'Architect') return { text: PLAN_JSON, toolCalls: [] };
    if (agent === 'Reviewer') return { text: PASS_JSON(['AC-001'], 'lib/app.js'), toolCalls: [] };
    return { text: CHANGE_JSON, toolCalls: [] };
  });

describe('composition root', () => {
  it('loads bundled gates, agents and the example task', async () => {
    const root = await workspace();
    const services = await createServices({ workspaceRoot: root, extensionRoot: REPO_ROOT, client: client(), logger: new MemoryLogger() });
    expect([...services.gateRegistry.ids()].sort()).toEqual(['architecture', 'coverage', 'dart_analyze', 'dcm', 'flutter_test', 'opengrep', 'security']);
    const loaded = await services.taskLoader.load('tasks/example.yaml', services.gateRegistry.ids());
    expect(loaded.task.id).toBe('AUTH-142');
  });

  it('blocks with a clear configuration error when gate tools are not installed', async () => {
    const root = await workspace();
    const services = await createServices({ workspaceRoot: root, extensionRoot: REPO_ROOT, client: client(), logger: new MemoryLogger(), processes: undefined });
    const loaded = await services.taskLoader.load('tasks/example.yaml', services.gateRegistry.ids());
    // Force every gate command to a missing executable regardless of what the host has installed.
    for (const g of services.gateRegistry.all()) services.gateRegistry.register({ ...g, command: `missing-${g.id}-xyz` });
    const final = await services.controller.start(loaded);
    expect(final.state).toBe('BLOCKED');
    expect(final.blocked?.code).toBe('CONFIGURATION_ERROR');
    expect(final.blocked?.message).toMatch(/missing-dart_analyze-xyz/);
    const state = JSON.parse(await fs.readFile(path.join(root, '.copilot-loop/state.json'), 'utf8')) as { state: string };
    expect(state.state).toBe('BLOCKED');
  });

  it('runs a real mock-agent loop end to end with workspace gates, persistence and history', async () => {
    const root = await workspace();
    execFileSync('git', ['init', '-q'], { cwd: root });
    await fs.mkdir(path.join(root, '.copilot-loop/gates'), { recursive: true });
    await fs.mkdir(path.join(root, 'lib'), { recursive: true });
    await fs.writeFile(path.join(root, 'lib/app.js'), 'module.exports = 1;\n');
    // A workspace gate that fails until lib/fixed.txt exists.
    await fs.writeFile(path.join(root, '.copilot-loop/gates/check.json'), JSON.stringify({ id: 'check', name: 'check', category: 'lint', command: 'node', args: ['-e', "const fs=require('fs');if(!fs.existsSync('lib/fixed.txt')){console.log('lib/app.js:1:1: error: needs fix [needs_fix]');process.exit(1)}"], parser: 'generic' }));
    await fs.writeFile(path.join(root, 'tasks/t.yaml'), 'id: E2E\ntitle: e2e\ngoal: fix it\nacceptance: [fixed]\ngates: [check]\n');
    const mock = new MockCopilotClient((request, i) => {
      const agent = agentOf(request);
      if (agent === 'Architect') return { text: PLAN_JSON, toolCalls: [] };
      if (agent === 'Reviewer') return { text: PASS_JSON(['AC-001'], 'lib/fixed.txt'), toolCalls: [] };
      if (agent === 'Refactoring Specialist' && !request.messages.some((m) => m.parts.some((p) => p.type === 'tool_result'))) {
        return { text: '', toolCalls: [{ callId: `w${i}`, name: 'workspace_write_file', input: { path: 'lib/fixed.txt', content: 'ok' } }] };
      }
      return { text: CHANGE_JSON, toolCalls: [] };
    });
    const services = await createServices({ workspaceRoot: root, extensionRoot: REPO_ROOT, client: mock, logger: new MemoryLogger() });
    const loaded = await services.taskLoader.load('tasks/t.yaml', services.gateRegistry.ids());
    const final = await services.controller.start(loaded);
    expect(final.blocked).toBeUndefined();
    expect(final.state).toBe('DONE');
    expect(final.changedFiles).toContain('lib/fixed.txt');
    expect((await services.store.listHistory()).length).toBeGreaterThan(5);
    // The run lock is released after the run.
    await expect(fs.stat(path.join(root, '.copilot-loop/run.lock'))).rejects.toThrow();
    // The agent never wrote protected files and the loop never committed.
    const heads = execFileSync('git', ['for-each-ref', 'refs/heads', 'refs/remotes'], { cwd: root, encoding: 'utf8' }).trim();
    expect(heads).toBe('');
  });

  it('protects the task file and gate configuration referenced by the task', async () => {
    const root = await workspace();
    const services = await createServices({ workspaceRoot: root, extensionRoot: REPO_ROOT, client: client(), logger: new MemoryLogger() });
    for (const g of services.gateRegistry.all()) services.gateRegistry.register({ ...g, command: 'missing-xyz' });
    await services.controller.start(await services.taskLoader.load('tasks/example.yaml', services.gateRegistry.ids()));
    expect(() => services.policy.assertWritable('tasks/example.yaml')).toThrow(/protected/);
    expect(() => services.policy.assertWritable('.github/architecture/opengrep.yml')).toThrow(/protected/);
    expect(() => services.policy.assertWritable('tool/architecture_validator.dart')).toThrow(/protected/);
    expect(() => services.policy.assertWritable('pubspec.yaml')).not.toThrow();
    expect(() => services.policy.assertWritable('lib/features/auth/session.dart')).not.toThrow();
  });

  it('loads repository instructions with size limits', async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, '.github/instructions'), { recursive: true });
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(50000));
    await fs.writeFile(path.join(root, '.github/instructions/dart.instructions.md'), 'use MVVM');
    const list = await loadRepositoryInstructions(root);
    expect(list.map((i) => i.source)).toEqual(['AGENTS.md', '.github/instructions/dart.instructions.md']);
    expect(list[0]!.text.length).toBeLessThanOrEqual(6000);
  });
});
