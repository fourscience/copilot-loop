import { LoopError, isLoopError, throwIfAborted, toLoopError } from '../core/errors';
import type { Logger } from '../core/ports';
import { redactSecrets } from '../core/redact';
import { estimateTokens, truncate } from '../core/text';
import type { ChatMessage, CopilotClient, ModelInfo } from '../copilot/copilot-client';
import type { AgentOutcome } from '../persistence/models';
import { parseAgentOutput, type OutputTypes } from './agent-output';
import type { AgentDefinition } from './agent-registry';
import { executeTool, toolsFor, type ToolContext } from './agent-tools';

export interface AgentInvocation {
  agent: AgentDefinition;
  model: ModelInfo;
  system: string;
  user: string;
  toolContext: ToolContext;
  /** Maximum model round-trips in this run. */
  maxTurns: number;
  /** Conversation budget in estimated tokens. */
  maxInputTokens: number;
  signal?: AbortSignal;
  onText?: (fragment: string) => void;
}

export interface AgentRunResult<K extends keyof OutputTypes = keyof OutputTypes> {
  outcome: AgentOutcome;
  output?: OutputTypes[K];
  outputError?: string;
  finalText: string;
  turns: number;
  toolCalls: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  writes: string[];
  transcript: { role: string; text: string }[];
}

const MAX_TRANSCRIPT_ENTRY = 4000;

function messageTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      total += estimateTokens(p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : JSON.stringify(p.input)) + 4;
    }
  }
  return total;
}

/** Replaces old tool results with a stub so long tool sessions stay inside the budget. */
function compactToolResults(messages: ChatMessage[], keepLast: number): boolean {
  let seen = 0;
  let changed = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    for (let j = 0; j < m.parts.length; j++) {
      const p = m.parts[j];
      if (p?.type !== 'tool_result') continue;
      seen++;
      if (seen > keepLast && p.content.length > 200) {
        m.parts[j] = { ...p, content: '[earlier tool result elided to save context; call the tool again if needed]' };
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Runs one agent: a bounded tool-calling conversation with a single model.
 * Requests are strictly sequential (never concurrent), cancellation is
 * checked before every request and tool call, and the structured result is
 * validated against the agent's output schema with one repair attempt.
 */
export class AgentRunner {
  constructor(
    private readonly client: CopilotClient,
    private readonly logger: Logger,
  ) {}

  async run<K extends keyof OutputTypes>(inv: AgentInvocation): Promise<AgentRunResult<K>> {
    const tools = toolsFor(inv.agent.tools);
    const toolSpecs = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    // The VS Code LM API has no stable system role, so policy goes first in the first user message.
    const messages: ChatMessage[] = [{ role: 'user', parts: [{ type: 'text', text: `${inv.system}\n\n${inv.user}` }] }];
    const transcript: { role: string; text: string }[] = [{ role: 'user', text: truncate(redactSecrets(inv.user), MAX_TRANSCRIPT_ENTRY) }];
    const writes = new Set<string>();
    const toolContext: ToolContext = { ...inv.toolContext, onWrite: (p) => { writes.add(p); inv.toolContext.onWrite(p); } };
    let turns = 0;
    let toolCallCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let repaired = false;
    let finalText = '';

    const result = (outcome: AgentOutcome, extra: Partial<AgentRunResult<K>> = {}): AgentRunResult<K> => ({
      outcome, finalText, turns, toolCalls: toolCallCount, estimatedInputTokens: inputTokens, estimatedOutputTokens: outputTokens, writes: [...writes].sort(), transcript, ...extra,
    });

    while (turns < inv.maxTurns) {
      throwIfAborted(inv.signal, `Agent ${inv.agent.id}`);
      let promptTokens = messageTokens(messages);
      if (promptTokens > inv.maxInputTokens) {
        compactToolResults(messages, 2);
        promptTokens = messageTokens(messages);
        if (promptTokens > inv.maxInputTokens) {
          this.logger.warn(`Agent ${inv.agent.id} exhausted its context budget`, { promptTokens, budget: inv.maxInputTokens });
          return result('budget_exhausted', { outputError: `context budget of ${inv.maxInputTokens} tokens exhausted` });
        }
      }
      turns++;
      inputTokens += promptTokens;
      let response;
      try {
        response = await this.client.send({
          model: inv.model,
          messages,
          tools: toolSpecs,
          justification: `Copilot Loop runs the ${inv.agent.name} agent to work on your task.`,
          ...(inv.signal ? { signal: inv.signal } : {}),
          ...(inv.onText ? { onText: inv.onText } : {}),
        });
      } catch (error) {
        const e = toLoopError(error, 'MODEL_REQUEST_FAILED', `Agent ${inv.agent.id}`);
        if (e.code === 'USER_CANCELLED' || inv.signal?.aborted) throw new LoopError('USER_CANCELLED', `Agent ${inv.agent.id} cancelled`);
        throw e;
      }
      outputTokens += estimateTokens(response.text) + response.toolCalls.reduce((n, c) => n + estimateTokens(JSON.stringify(c.input)), 0);
      finalText = response.text;
      messages.push({
        role: 'assistant',
        parts: [...(response.text ? [{ type: 'text' as const, text: response.text }] : []), ...response.toolCalls.map((c) => ({ type: 'tool_call' as const, callId: c.callId, name: c.name, input: c.input }))],
      });
      transcript.push({ role: 'assistant', text: truncate(redactSecrets(response.text + response.toolCalls.map((c) => `\n[tool_call ${c.name} ${JSON.stringify(c.input)}]`).join('')), MAX_TRANSCRIPT_ENTRY) });

      if (response.toolCalls.length > 0) {
        const resultParts: ChatMessage['parts'] = [];
        for (const call of response.toolCalls) {
          throwIfAborted(inv.signal, `Agent ${inv.agent.id}`);
          toolCallCount++;
          const exec = await executeTool(call.name, call.input, tools, toolContext);
          this.logger.debug(`Tool ${call.name}${exec.isError ? ' (error)' : ''}`, { agent: inv.agent.id });
          resultParts.push({ type: 'tool_result', callId: call.callId, content: exec.content, isError: exec.isError });
          transcript.push({ role: 'tool', text: truncate(`${call.name}: ${exec.content}`, MAX_TRANSCRIPT_ENTRY) });
        }
        messages.push({ role: 'user', parts: resultParts });
        continue;
      }

      const parsed = parseAgentOutput(inv.agent.output, response.text);
      if (parsed.ok) {
        return result('completed', { output: parsed.value as OutputTypes[K] });
      }
      if (!repaired && turns < inv.maxTurns) {
        repaired = true;
        const repair = `Your answer could not be accepted: ${parsed.error}\nReply again with only the required \`\`\`json block.`;
        messages.push({ role: 'user', parts: [{ type: 'text', text: repair }] });
        transcript.push({ role: 'user', text: repair });
        continue;
      }
      return result('invalid_output', { outputError: parsed.error });
    }
    return result('turn_limit', { outputError: `turn limit of ${inv.maxTurns} reached` });
  }
}

export function isCancellation(error: unknown): boolean {
  return isLoopError(error) && error.code === 'USER_CANCELLED';
}
