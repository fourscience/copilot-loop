import { LoopError, throwIfAborted } from '../core/errors';
import { selectBestModel } from '../agents/model-selector';
import type { AgentRequest, AgentResponse, CopilotClient, ModelInfo, ModelRequirements } from './copilot-client';

export type MockResponder = (request: AgentRequest, callIndex: number) => AgentResponse | Promise<AgentResponse>;

export const MOCK_MODELS: ModelInfo[] = [
  { id: 'mock-reasoning', vendor: 'copilot', family: 'gpt-5', version: '1', name: 'Mock Reasoning', maxInputTokens: 128000 },
  { id: 'mock-fast', vendor: 'copilot', family: 'gpt-5-mini', version: '1', name: 'Mock Fast', maxInputTokens: 128000 },
];

/**
 * Deterministic CopilotClient for tests and CI. Responses come from a
 * responder function so tests can script agent behaviour per request.
 */
export class MockCopilotClient implements CopilotClient {
  readonly requests: AgentRequest[] = [];
  /** Number of requests currently in flight (used to assert no duplicate concurrent requests). */
  inFlight = 0;
  maxConcurrent = 0;

  constructor(
    private readonly responder: MockResponder,
    private readonly models: ModelInfo[] = MOCK_MODELS,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }

  async selectModel(requirements: ModelRequirements): Promise<ModelInfo> {
    return selectBestModel(this.models, requirements);
  }

  async send(request: AgentRequest): Promise<AgentResponse> {
    throwIfAborted(request.signal, 'Model request');
    if (!this.models.some((m) => m.id === request.model.id)) {
      throw new LoopError('MODEL_UNAVAILABLE', `Model ${request.model.id} is not available`);
    }
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      this.requests.push(structuredClone({ ...request, signal: undefined, onText: undefined }));
      const response = await this.responder(request, this.requests.length - 1);
      throwIfAborted(request.signal, 'Model request');
      if (response.text) request.onText?.(response.text);
      return response;
    } finally {
      this.inFlight--;
    }
  }
}
