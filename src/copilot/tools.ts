import * as vscode from 'vscode';
import type { ChatMessage, ToolSpec } from './copilot-client';

/**
 * Converts controller-defined tools into VS Code LanguageModelChatTool
 * descriptors. Tools are passed per request (not registered globally with
 * vscode.lm.registerTool), so they are never exposed to other chat
 * participants and each agent sees only the tools its policy allows.
 */
export function toLanguageModelTools(tools: readonly ToolSpec[]): vscode.LanguageModelChatTool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export function toLanguageModelMessages(messages: readonly ChatMessage[]): vscode.LanguageModelChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) parts.push(new vscode.LanguageModelTextPart(p.text));
        else if (p.type === 'tool_call') parts.push(new vscode.LanguageModelToolCallPart(p.callId, p.name, p.input));
      }
      return vscode.LanguageModelChatMessage.Assistant(parts.length ? parts : '');
    }
    const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
    for (const p of m.parts) {
      if (p.type === 'text') parts.push(new vscode.LanguageModelTextPart(p.text));
      else if (p.type === 'tool_result') parts.push(new vscode.LanguageModelToolResultPart(p.callId, [new vscode.LanguageModelTextPart(p.isError ? `ERROR: ${p.content}` : p.content)]));
    }
    return vscode.LanguageModelChatMessage.User(parts);
  });
}
