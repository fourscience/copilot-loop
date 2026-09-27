import { describe, expect, it } from 'vitest';
import { AGENT_POLICY, parseAgentDefinition } from '../src/agents/agent-registry';
import { extractJsonBlock, parseAgentOutput } from '../src/agents/agent-output';
import { AGENT_IDS } from '../src/persistence/models';
import { bundledAgents } from './helpers';

describe('agent registry', () => {
  it('loads every bundled agent and covers all roles', async () => {
    const registry = await bundledAgents();
    registry.assertComplete();
    for (const id of AGENT_IDS) {
      const agent = registry.get(id);
      expect(agent.instructions).toMatch(/## You own/);
      expect(agent.instructions).toMatch(/## You must not/);
      expect(agent.instructions).toMatch(/## Success/);
      expect(agent.instructions).toMatch(/## Output/);
      for (const tool of agent.tools) expect(AGENT_POLICY[id].maxTools).toContain(tool);
    }
  });

  it('keeps read-only agents read-only', async () => {
    const registry = await bundledAgents();
    for (const id of ['architect', 'diagnoser', 'reviewer'] as const) {
      expect(registry.get(id).writes).toBe(false);
      expect(registry.get(id).tools.some((t) => t.startsWith('workspace_write') || t.startsWith('workspace_replace'))).toBe(false);
    }
  });

  it('rejects an agent file that tries to grant itself write tools', () => {
    const text = '---\nid: reviewer\ntools: [workspace_write_file]\n---\nbody';
    expect(() => parseAgentDefinition(text, 'evil.agent.md')).toThrow(/not permitted/);
  });

  it('rejects unknown agents, tools and output kinds', () => {
    expect(() => parseAgentDefinition('---\nid: hacker\n---\nx', 'a')).toThrow(/unknown agent id/);
    expect(() => parseAgentDefinition('---\nid: debugger\ntools: [shell_exec]\n---\nx', 'a')).toThrow(/unknown tool/);
    expect(() => parseAgentDefinition('---\nid: debugger\noutput: review\n---\nx', 'a')).toThrow(/output must be 'change'/);
    expect(() => parseAgentDefinition('no front matter', 'a')).toThrow(/front matter/);
  });
});

describe('agent output parsing', () => {
  it('extracts the last fenced JSON block', () => {
    expect(extractJsonBlock('a ```json\n{"x":1}\n``` b ```json\n{"x":2}\n```')).toBe('{"x":2}');
    expect(extractJsonBlock('result: {"a": {"b": 1}} trailing')).toBe('{"a": {"b": 1}}');
  });

  it('validates review verdicts strictly', () => {
    expect(parseAgentOutput('review', '```json\n{"verdict":"PASS","reasons":[],"criteria":[]}\n```').ok).toBe(true);
    const bad = parseAgentOutput('review', '```json\n{"verdict":"LGTM","reasons":[],"criteria":[]}\n```');
    expect(bad.ok).toBe(false);
    expect(parseAgentOutput('review', 'PASS').ok).toBe(false);
  });

  it('restricts diagnoser recommendations to specialists', () => {
    const r = parseAgentOutput('diagnosis', '```json\n{"diagnoses":[{"category":"test","rootCause":"x","recommendedAgent":"reviewer"}]}\n```');
    expect(r.ok).toBe(false);
  });
});
