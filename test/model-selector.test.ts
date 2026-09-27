import { describe, expect, it } from 'vitest';
import { selectBestModel } from '../src/agents/model-selector';
import type { ModelInfo } from '../src/copilot/copilot-client';

const m = (family: string, vendor = 'copilot'): ModelInfo => ({ id: family, vendor, family, version: '1', name: family, maxInputTokens: 100000 });
const MODELS = [m('gpt-4o-mini'), m('gpt-5'), m('claude-sonnet-4'), m('gemini-2.0-flash'), m('gpt-4o')];

describe('model selector', () => {
  it('prefers strong reasoning models for reasoning-heavy agents', () => {
    expect(['gpt-5', 'claude-sonnet-4']).toContain(selectBestModel(MODELS, { reasoning: 'high' }).family);
  });

  it('prefers fast models for mechanical work', () => {
    expect(['gpt-4o-mini', 'gemini-2.0-flash']).toContain(selectBestModel(MODELS, { coding: 'medium', speed: 'high' }).family);
  });

  it('is deterministic', () => {
    const a = selectBestModel(MODELS, { coding: 'high', speed: 'medium' });
    const b = selectBestModel([...MODELS].reverse(), { coding: 'high', speed: 'medium' });
    expect(a.id).toBe(b.id);
  });

  it('falls back to any Copilot model when metadata is uninformative', () => {
    expect(selectBestModel([m('mystery')], { reasoning: 'high' }).id).toBe('mystery');
  });

  it('honours a family preference when available and ignores it otherwise', () => {
    expect(selectBestModel(MODELS, { reasoning: 'high', preferFamily: 'gpt-4o' }).family).toMatch(/gpt-4o/);
    expect(selectBestModel(MODELS, { reasoning: 'high', preferFamily: 'nope' }).family).toBeDefined();
  });

  it('never selects non-Copilot models and blocks when none exist', () => {
    expect(() => selectBestModel([m('gpt-5', 'other')], {})).toThrow(expect.objectContaining({ code: 'MODEL_UNAVAILABLE' }));
    expect(() => selectBestModel([], {})).toThrow(/No GitHub Copilot chat model/);
  });
});
