import * as vscode from 'vscode';
import type { LoopRecord } from '../persistence/models';

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  color?: string;
  children?: Node[];
  command?: vscode.Command;
  /** Workspace-relative file opened on click. */
  openFile?: string;
  openLine?: number;
}

function gateIcon(status: string): { icon: string; color: string } {
  if (status === 'passed') return { icon: 'pass', color: 'testing.iconPassed' };
  if (status === 'failed') return { icon: 'error', color: 'testing.iconFailed' };
  return { icon: 'warning', color: 'problemsWarningIcon.foreground' };
}

const CRITERION_ICON: Record<string, string> = { verified: 'pass', failed: 'error', blocked: 'circle-slash', in_progress: 'loading~spin', unknown: 'question' };

/** Builds the tree model; kept separate from the provider for readability. */
export function buildDashboard(record: LoopRecord | undefined, running: boolean): Node[] {
  if (!record) {
    return [{ label: 'No task', description: 'Run "Copilot Loop: Start Task"', icon: 'info', command: { title: 'Start', command: 'copilotLoop.start' } }];
  }
  const used = record.iteration - record.iterationBase;
  const nodes: Node[] = [
    { label: 'Task', description: `${record.task.id} — ${record.task.title}`, icon: 'tasklist', command: { title: 'Open Task', command: 'copilotLoop.openTask' } },
    { label: 'Status', description: `${record.state}${running ? ' (running)' : ''}`, icon: running ? 'sync~spin' : 'circle-filled', ...(record.blocked ? { tooltip: `${record.blocked.code}: ${record.blocked.message}` } : {}) },
    { label: 'Iteration', description: String(record.iteration), icon: 'debug-step-over' },
    { label: 'Current Agent', description: record.currentAgent ?? '—', icon: 'person' },
    { label: 'Current Model', description: record.currentModel ?? '—', icon: 'hubot' },
  ];
  if (record.blocked) {
    nodes.push({ label: 'Blocked', description: record.blocked.code, tooltip: record.blocked.message, icon: 'error', color: 'errorForeground', children: record.blocked.message.split('\n').slice(0, 12).map((l) => ({ label: l })) });
  }
  nodes.push({
    label: 'Gates',
    icon: 'checklist',
    description: record.lastGateResults.length ? `${record.lastGateResults.filter((g) => g.status === 'passed').length}/${record.lastGateResults.length} passing` : 'not run',
    children: record.task.gates.map((id) => {
      const r = record.lastGateResults.find((g) => g.gateId === id);
      if (!r) return { label: id, description: 'not run', icon: 'circle-outline' };
      const { icon, color } = gateIcon(r.status);
      return { label: id, description: r.status === 'passed' ? 'passed' : `${r.status} (${r.diagnostics.length})`, icon, color, ...(r.error ? { tooltip: r.error.message } : {}) };
    }),
  });
  nodes.push({
    label: 'Failures',
    icon: 'bug',
    description: String(record.lastFailures.length),
    children: record.lastFailures.slice(0, 50).map((d) => ({
      label: `${d.category}: ${d.message.split('\n')[0]?.slice(0, 120) ?? ''}`,
      description: d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : d.gate,
      tooltip: d.message,
      icon: 'error',
      ...(d.file ? { openFile: d.file, ...(d.line ? { openLine: d.line } : {}) } : {}),
    })),
  });
  nodes.push({
    label: 'Acceptance',
    icon: 'verified',
    description: `${record.criteria.filter((c) => c.status === 'verified').length}/${record.criteria.length} verified`,
    children: record.criteria.map((c) => ({ label: `${c.id}: ${c.description}`, description: c.status, ...(c.notes ? { tooltip: c.notes } : {}), icon: CRITERION_ICON[c.status] ?? 'question' })),
  });
  const recent = record.recentAgents.at(-1);
  nodes.push({ label: 'Recent agent', description: recent ? `${recent.agent} (${recent.outcome})` : '—', icon: 'history', ...(recent ? { tooltip: recent.summary } : {}) });
  nodes.push({ label: 'Progress', description: `${used} / ${record.task.limits.maxIterations} iterations`, icon: 'graph' });
  return nodes;
}

export class DashboardProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private nodes: Node[] = buildDashboard(undefined, false);
  private workspaceRoot: vscode.Uri | undefined;

  setWorkspace(root: vscode.Uri): void {
    this.workspaceRoot = root;
  }

  update(record: LoopRecord | undefined, running: boolean): void {
    this.nodes = buildDashboard(record, running);
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip) item.tooltip = node.tooltip;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
    if (node.command) item.command = node.command;
    if (node.openFile && this.workspaceRoot && !node.openFile.startsWith('/')) {
      const line = Math.max(0, (node.openLine ?? 1) - 1);
      item.command = { title: 'Open', command: 'vscode.open', arguments: [vscode.Uri.joinPath(this.workspaceRoot, node.openFile), { selection: new vscode.Range(line, 0, line, 0) }] };
    }
    return item;
  }

  getChildren(node?: Node): Node[] {
    return node ? (node.children ?? []) : this.nodes;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
