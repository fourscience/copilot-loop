import * as vscode from 'vscode';
import { selectBestModel } from '../agents/model-selector';
import { LoopError } from '../core/errors';
import { COPILOT_VENDOR, type AgentRequest, type AgentResponse, type CopilotClient, type ModelInfo, type ModelRequirements, type ToolCall } from './copilot-client';
import { toLanguageModelMessages, toLanguageModelTools } from './tools';

function toInfo(model: vscode.LanguageModelChat): ModelInfo {
  return { id: model.id, vendor: model.vendor, family: model.family, version: model.version, name: model.name, maxInputTokens: model.maxInputTokens };
}

function linkSignal(signal: AbortSignal | undefined): { token: vscode.CancellationToken; dispose: () => void } {
  const cts = new vscode.CancellationTokenSource();
  const onAbort = (): void => cts.cancel();
  if (signal?.aborted) cts.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    token: cts.token,
    dispose: () => {
      signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    },
  };
}

/**
 * CopilotClient backed by the VS Code Language Model API. Only models from
 * the `copilot` vendor are ever used; there is no fallback to other providers.
 */
export class VsCodeCopilotClient implements CopilotClient {
  private models = new Map<string, vscode.LanguageModelChat>();

  async listModels(): Promise<ModelInfo[]> {
    let models: vscode.LanguageModelChat[];
    try {
      models = await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR });
    } catch (error) {
      throw new LoopError('MODEL_UNAVAILABLE', `Could not query Copilot models: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.models = new Map(models.filter((m) => m.vendor === COPILOT_VENDOR).map((m) => [m.id, m]));
    return [...this.models.values()].map(toInfo);
  }

  async selectModel(requirements: ModelRequirements): Promise<ModelInfo> {
    return selectBestModel(await this.listModels(), requirements);
  }

  async send(request: AgentRequest): Promise<AgentResponse> {
    let model = this.models.get(request.model.id);
    if (!model) {
      await this.listModels();
      model = this.models.get(request.model.id);
    }
    if (!model) throw new LoopError('MODEL_UNAVAILABLE', `Copilot model '${request.model.id}' is no longer available`);

    const { token, dispose } = linkSignal(request.signal);
    try {
      const response = await model.sendRequest(
        toLanguageModelMessages(request.messages),
        {
          justification: request.justification,
          ...(request.tools.length ? { tools: toLanguageModelTools(request.tools), toolMode: vscode.LanguageModelChatToolMode.Auto } : {}),
        },
        token,
      );
      let text = '';
      const toolCalls: ToolCall[] = [];
      for await (const part of response.stream) {
        if (token.isCancellationRequested) throw new LoopError('USER_CANCELLED', 'Model request cancelled');
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          request.onText?.(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          const input = part.input && typeof part.input === 'object' && !Array.isArray(part.input) ? (part.input as Record<string, unknown>) : {};
          toolCalls.push({ callId: part.callId, name: part.name, input });
        }
      }
      return { text, toolCalls };
    } catch (error) {
      if (error instanceof LoopError) throw error;
      if (token.isCancellationRequested || error instanceof vscode.CancellationError) {
        throw new LoopError('USER_CANCELLED', 'Model request cancelled');
      }
      if (error instanceof vscode.LanguageModelError) {
        const code = error.code === 'NotFound' || error.code === 'NoPermissions' ? 'MODEL_UNAVAILABLE' : 'MODEL_REQUEST_FAILED';
        throw new LoopError(code, `Copilot request failed (${error.code}): ${error.message}`, { model: request.model.id, lmCode: error.code });
      }
      throw new LoopError('MODEL_REQUEST_FAILED', `Copilot request failed: ${error instanceof Error ? error.message : String(error)}`, { model: request.model.id });
    } finally {
      dispose();
    }
  }
}
