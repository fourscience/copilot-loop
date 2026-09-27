import * as vscode from 'vscode';
import type { LoopRecord } from '../persistence/models';

const ICONS: Record<string, string> = {
  DONE: '$(pass-filled)',
  BLOCKED: '$(error)',
  PAUSED: '$(debug-pause)',
  STOPPED: '$(circle-slash)',
};

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  constructor() {
    this.item.command = 'copilotLoop.status';
    this.update(undefined, false);
    this.item.show();
  }

  update(record: LoopRecord | undefined, running: boolean): void {
    if (!record) {
      this.item.text = '$(sync) Copilot Loop';
      this.item.tooltip = 'Copilot Loop: no task. Run "Copilot Loop: Start Task".';
      return;
    }
    const icon = running ? '$(sync~spin)' : (ICONS[record.state] ?? '$(sync)');
    const used = record.iteration - record.iterationBase;
    this.item.text = `${icon} ${record.task.id} ${record.state} ${used}/${record.task.limits.maxIterations}`;
    this.item.tooltip = `${record.task.title}\nState: ${record.state}${record.currentAgent ? `\nAgent: ${record.currentAgent}` : ''}${record.blocked ? `\n${record.blocked.code}: ${record.blocked.message}` : ''}`;
    this.item.backgroundColor = record.state === 'BLOCKED' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
