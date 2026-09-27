/**
 * Framework-independent model client port. The VS Code implementation lives in
 * ./chat.ts; tests use ./mock-copilot-client.ts. Nothing in this file may
 * import 'vscode'.
 */

export type CapabilityLevel = 'low' | 'medium' | 'high';

export interface ModelRequirements {
  reasoning?: CapabilityLevel;
  coding?: CapabilityLevel;
  speed?: CapabilityLevel;
  /** Substring preference for model family/id (from user settings). Never selects a non-Copilot model. */
  preferFamily?: string;
}

export interface ModelInfo {
  id: string;
  vendor: string;
  family: string;
  version: string;
  name: string;
  maxInputTokens: number;
}

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentRequest {
  model: ModelInfo;
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** Shown by VS Code when asking the user for model access consent. */
  justification: string;
  signal?: AbortSignal;
  /** Streaming callback for text fragments. */
  onText?: (fragment: string) => void;
}

export interface AgentResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface CopilotClient {
  /** Lists available Copilot chat models. Never returns models from other vendors. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Capability-based selection. Throws MODEL_UNAVAILABLE when nothing usable exists. */
  selectModel(requirements: ModelRequirements, signal?: AbortSignal): Promise<ModelInfo>;
  /** Sends one request (one model turn). Throws MODEL_REQUEST_FAILED / USER_CANCELLED. */
  send(request: AgentRequest): Promise<AgentResponse>;
}

export const COPILOT_VENDOR = 'copilot';
