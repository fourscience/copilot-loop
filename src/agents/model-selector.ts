import { LoopError } from '../core/errors';
import { COPILOT_VENDOR, type CapabilityLevel, type ModelInfo, type ModelRequirements } from '../copilot/copilot-client';

export interface ModelCapabilities {
  reasoning: number;
  coding: number;
  speed: number;
}

/**
 * VS Code exposes no capability metadata, so capabilities are inferred from
 * family/id naming conventions. Unknown models get neutral scores, which makes
 * selection fall back safely to any available Copilot model.
 */
export function inferCapabilities(model: ModelInfo): ModelCapabilities {
  const name = `${model.family} ${model.id} ${model.name}`.toLowerCase();
  const caps: ModelCapabilities = { reasoning: 2, coding: 2, speed: 2 };
  const small = /(mini|nano|flash|haiku|lite|small|fast|turbo)/.test(name);
  if (small) {
    caps.speed = 3;
    caps.reasoning = 1;
    caps.coding = /codex|haiku/.test(name) ? 2 : 1;
  }
  if (/(\bo[134]\b|\bo[134]-|opus|reason|thinking|gpt-5|sonnet|gemini-[\d.]+-pro|\bpro\b)/.test(name) && !small) {
    caps.reasoning = 3;
    caps.speed = 1;
  }
  if (/(codex|sonnet|opus|gpt-5|gpt-4\.1|claude)/.test(name) && !small) {
    caps.coding = 3;
  }
  return caps;
}

const WEIGHT: Record<CapabilityLevel, number> = { low: 0, medium: 1, high: 3 };

export function scoreModel(model: ModelInfo, requirements: ModelRequirements): number {
  const caps = inferCapabilities(model);
  let score = 0;
  if (requirements.reasoning) score += WEIGHT[requirements.reasoning] * caps.reasoning;
  if (requirements.coding) score += WEIGHT[requirements.coding] * caps.coding;
  if (requirements.speed) score += WEIGHT[requirements.speed] * caps.speed;
  // Larger context windows are a small tie-breaker.
  score += Math.min(1, Math.log10(Math.max(1, model.maxInputTokens)) / 10);
  return score;
}

/** Deterministic capability-based selection among Copilot models only. */
export function selectBestModel(models: readonly ModelInfo[], requirements: ModelRequirements): ModelInfo {
  const usable = models.filter((m) => m.vendor === COPILOT_VENDOR && m.maxInputTokens > 0);
  if (usable.length === 0) {
    throw new LoopError('MODEL_UNAVAILABLE', 'No GitHub Copilot chat model is available. Sign in to GitHub Copilot and ensure your organization allows Copilot Chat models in VS Code.');
  }
  let candidates = usable;
  if (requirements.preferFamily) {
    const pref = requirements.preferFamily.toLowerCase();
    const preferred = usable.filter((m) => m.family.toLowerCase().includes(pref) || m.id.toLowerCase().includes(pref));
    if (preferred.length > 0) candidates = preferred;
  }
  const ranked = [...candidates].sort((a, b) => scoreModel(b, requirements) - scoreModel(a, requirements) || a.id.localeCompare(b.id));
  return ranked[0] as ModelInfo;
}
