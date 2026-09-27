import * as path from 'node:path';
import * as vscode from 'vscode';
import { createServices, STATE_DIR, type LoopServices } from './bootstrap';
import { VsCodeCopilotClient } from './copilot/chat';
import { isActive } from './controller/state-machine';
import { isLoopError } from './core/errors';
import type { LogLevel } from './core/ports';
import type { AgentId, LoopRecord } from './persistence/models';
import { DashboardProvider } from './ui/dashboard';
import { OutputChannelLogger } from './ui/output';
import { StatusBar } from './ui/status';

let services: Promise<LoopServices> | undefined;
let logger: OutputChannelLogger | undefined;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('copilotLoop');
}

function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') {
    throw new Error('Copilot Loop needs a local folder open in VS Code.');
  }
  return folder;
}

function describe(record: LoopRecord | undefined): string {
  if (!record) return 'No Copilot Loop task in this workspace.';
  const used = record.iteration - record.iterationBase;
  const gates = record.lastGateResults.map((g) => `${g.status === 'passed' ? '✓' : '✗'} ${g.gateId}`).join('  ');
  return [
    `${record.task.id}: ${record.task.title}`,
    `State ${record.state} · iteration ${used}/${record.task.limits.maxIterations} · agent runs ${record.agentRuns}`,
    gates ? `Gates: ${gates}` : 'Gates: not run yet',
    record.blocked ? `Blocked (${record.blocked.code}): ${record.blocked.message}` : '',
  ].filter(Boolean).join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
  logger = new OutputChannelLogger((config().get<LogLevel>('logLevel') ?? 'info'));
  const status = new StatusBar();
  const dashboard = new DashboardProvider();
  context.subscriptions.push(logger, status, dashboard, vscode.window.registerTreeDataProvider('copilotLoop.dashboard', dashboard));
  const log = logger;

  const render = (record: LoopRecord | undefined, running: boolean): void => {
    status.update(record, running);
    dashboard.update(record, running);
  };

  const getServices = (): Promise<LoopServices> => {
    if (!services) {
      const folder = workspaceFolder();
      dashboard.setWorkspace(folder.uri);
      services = createServices({
        workspaceRoot: folder.uri.fsPath,
        extensionRoot: context.extensionUri.fsPath,
        client: new VsCodeCopilotClient(),
        logger: log,
        modelPreferences: config().get<Partial<Record<AgentId, string>>>('modelPreferences') ?? {},
        gateTimeoutMs: config().get<number>('gateTimeoutMs'),
        events: { onRecord: (record) => void services?.then((s) => render(record, s.controller.isRunning)) },
      }).then((s) => {
        render(s.controller.current, s.controller.isRunning);
        return s;
      });
      services.catch(() => {
        services = undefined;
      });
    }
    return services;
  };

  const reportError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    const code = isLoopError(error) ? `${error.code}: ` : '';
    log.error(`${code}${message}`);
    void vscode.window.showErrorMessage(`Copilot Loop: ${code}${message}`);
  };

  /** Runs the loop in the background and reports the final state. */
  const background = (s: LoopServices, run: Promise<LoopRecord | undefined>): void => {
    render(s.controller.current, true);
    run
      .then((record) => {
        render(record, false);
        if (!record) return;
        if (record.state === 'DONE') void vscode.window.showInformationMessage(`Copilot Loop: ${record.task.id} is DONE.`);
        else if (record.state === 'BLOCKED') void vscode.window.showWarningMessage(`Copilot Loop BLOCKED (${record.blocked?.code ?? ''}): ${record.blocked?.message.split('\n')[0] ?? ''}`, 'Show Output', 'Retry').then((choice) => {
          if (choice === 'Show Output') log.show();
          if (choice === 'Retry') void vscode.commands.executeCommand('copilotLoop.retry');
        });
      })
      .catch((error: unknown) => {
        render(s.controller.current, false);
        reportError(error);
      });
  };

  const command = (id: string, handler: () => Promise<void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
        } catch (error) {
          reportError(error);
        }
      }),
    );
  };

  const pickTaskFile = async (root: vscode.Uri): Promise<string | undefined> => {
    const active = vscode.window.activeTextEditor?.document.uri;
    const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(root, `{${STATE_DIR}/tasks,tasks}/**/*.{yaml,yml}`), '**/node_modules/**', 200);
    const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = candidates.map((uri) => ({ label: path.relative(root.fsPath, uri.fsPath), uri }));
    if (active && /\.ya?ml$/i.test(active.fsPath) && active.fsPath.startsWith(root.fsPath) && !items.some((i) => i.uri?.fsPath === active.fsPath)) {
      items.unshift({ label: path.relative(root.fsPath, active.fsPath), description: 'active editor', uri: active });
    }
    items.push({ label: '$(folder-opened) Browse…' });
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Select a task contract (YAML)' });
    if (!choice) return undefined;
    let uri = choice.uri;
    if (!uri) {
      const picked = await vscode.window.showOpenDialog({ defaultUri: root, canSelectMany: false, filters: { 'Task contract': ['yaml', 'yml'] } });
      uri = picked?.[0];
    }
    if (!uri) return undefined;
    const rel = path.relative(root.fsPath, uri.fsPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('The task file must be inside the workspace.');
    return rel;
  };

  command('copilotLoop.start', async () => {
    const s = await getServices();
    const folder = workspaceFolder();
    const taskPath = await pickTaskFile(folder.uri);
    if (!taskPath) return;
    const loaded = await s.taskLoader.load(taskPath, s.gateRegistry.ids());
    const existing = s.controller.current;
    let replace = false;
    if (existing && (isActive(existing.state) || existing.state === 'PAUSED' || existing.state === 'BLOCKED')) {
      const ok = await vscode.window.showWarningMessage(`A run for ${existing.task.id} is ${existing.state}. Archive it and start ${loaded.task.id}?`, { modal: true }, 'Archive and Start');
      if (ok !== 'Archive and Start') return;
      replace = true;
    }
    log.show();
    background(s, s.controller.start(loaded, { replace }));
  });

  command('copilotLoop.pause', async () => {
    const s = await getServices();
    if (!s.controller.isRunning) {
      render(await s.controller.pause(), false);
      return;
    }
    void vscode.window.showInformationMessage('Copilot Loop will pause after the current step. Use Stop to cancel immediately.');
    void s.controller.pause();
  });

  command('copilotLoop.resume', async () => {
    const s = await getServices();
    const record = s.controller.current;
    if (record) {
      const current = await s.taskLoader.load(record.taskPath).catch(() => undefined);
      if (current && current.hash !== record.taskHash) {
        log.warn(`Task file ${record.taskPath} changed since the run started; the run continues with the original contract.`);
        void vscode.window.showWarningMessage(`The task file changed since ${record.task.id} started. The run continues with the original contract; start a new run to use the edited one.`);
      }
    }
    background(s, s.controller.resume());
  });

  command('copilotLoop.retry', async () => {
    const s = await getServices();
    const record = s.controller.current;
    if (record?.state !== 'BLOCKED') throw new Error(`Retry is only available when BLOCKED (current: ${record?.state ?? 'no task'})`);
    const ok = await vscode.window.showWarningMessage(`Retry ${record.task.id}? This resets repetition tracking and grants a new budget of ${record.task.limits.maxIterations} iterations.\n\n${record.blocked?.message ?? ''}`, { modal: true }, 'Retry');
    if (ok !== 'Retry') return;
    background(s, s.controller.retry());
  });

  command('copilotLoop.stop', async () => {
    const s = await getServices();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Stopping Copilot Loop…' }, async () => {
      render(await s.controller.stop(), false);
    });
  });

  command('copilotLoop.status', async () => {
    const s = await getServices();
    const text = describe(s.controller.current);
    log.info(text.replace(/\n/g, ' | '));
    const choice = await vscode.window.showInformationMessage(text, { modal: false }, 'Show Output', 'Show History');
    if (choice === 'Show Output') log.show();
    if (choice === 'Show History') await vscode.commands.executeCommand('copilotLoop.showHistory');
  });

  command('copilotLoop.validate', async () => {
    const s = await getServices();
    const record = s.controller.current;
    let gateIds = record?.task.gates;
    if (!gateIds) {
      const picked = await vscode.window.showQuickPick(s.gateRegistry.all().map((g) => ({ label: g.id, description: g.name, picked: true })), { canPickMany: true, placeHolder: 'Gates to run' });
      if (!picked?.length) return;
      gateIds = picked.map((p) => p.label);
    }
    const ids = gateIds;
    log.show();
    const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Copilot Loop: running gates', cancellable: true }, (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      return s.controller.validateOnly(ids, abort.signal);
    });
    for (const r of results) {
      log.info(`${r.status === 'passed' ? '✓' : '✗'} ${r.gateId}: ${r.status} (${r.diagnostics.length} diagnostics)${r.error ? ` — ${r.error.message}` : ''}`);
      for (const d of r.diagnostics.slice(0, 50)) log.info(`    ${d.severity} ${d.category} ${d.file ?? ''}${d.line ? `:${d.line}` : ''} ${d.rule ? `[${d.rule}] ` : ''}${d.message.split('\n')[0] ?? ''}`);
    }
    const failed = results.filter((r) => r.status !== 'passed');
    void vscode.window.showInformationMessage(failed.length ? `Copilot Loop: ${failed.length}/${results.length} gate(s) not passing: ${failed.map((f) => f.gateId).join(', ')}` : `Copilot Loop: all ${results.length} gates passed.`);
  });

  command('copilotLoop.openTask', async () => {
    const s = await getServices();
    const record = s.controller.current;
    const folder = workspaceFolder();
    const uri = record ? vscode.Uri.joinPath(folder.uri, record.taskPath) : undefined;
    if (!uri) {
      const rel = await pickTaskFile(folder.uri);
      if (rel) await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, rel));
      return;
    }
    await vscode.window.showTextDocument(uri);
  });

  command('copilotLoop.showHistory', async () => {
    const s = await getServices();
    const sequences = await s.store.listHistory();
    if (sequences.length === 0) {
      void vscode.window.showInformationMessage('Copilot Loop: no history yet.');
      return;
    }
    const items = await Promise.all(
      [...sequences].reverse().slice(0, 300).map(async (seq) => {
        const h = await s.store.readHistory(seq).catch(() => undefined);
        return { label: `#${seq} ${h?.phase ?? '?'}${h?.agent ? ` · ${h.agent}` : ''}`, description: `iteration ${h?.iteration ?? '?'} → ${h?.nextState ?? '?'}`, detail: h?.notes.join(' | ').slice(0, 200), seq };
      }),
    );
    const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Copilot Loop history (newest first)', matchOnDetail: true });
    if (choice) await vscode.window.showTextDocument(vscode.Uri.file(s.store.historyFile(choice.seq)), { preview: true });
  });

  command('copilotLoop.rollback', async () => {
    const s = await getServices();
    if (s.controller.isRunning) throw new Error('Stop or pause the loop before rolling back.');
    const record = s.controller.current;
    if (!record?.checkpoints.length) throw new Error('No checkpoints. Enable them with `git: { checkpoints: true }` in the task contract.');
    const choice = await vscode.window.showQuickPick(
      [...record.checkpoints].reverse().map((c) => ({ label: `iteration ${c.iteration}`, description: c.at, ref: c.ref })),
      { placeHolder: 'Restore the working tree to the state before this iteration' },
    );
    if (!choice) return;
    const ok = await vscode.window.showWarningMessage(`Restore the working tree to ${choice.ref}? Current uncommitted changes made after that checkpoint will be overwritten; files created after it will be deleted. Git history, branches and the index are not modified.`, { modal: true }, 'Roll Back');
    if (ok !== 'Roll Back') return;
    const changed = await s.git.restoreCheckpoint(choice.ref);
    log.info(`Rolled back to ${choice.ref}; ${changed.length} file(s) restored`);
    void vscode.window.showInformationMessage(`Copilot Loop: rolled back ${changed.length} file(s). Run Validate or Retry to continue.`);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copilotLoop.logLevel')) log.setLevel(config().get<LogLevel>('logLevel') ?? 'info');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      if (e.removed.length && services) {
        const s = await services;
        if (s.controller.isRunning) {
          log.warn('Workspace folder removed; interrupting the loop');
          await s.controller.interrupt();
        }
      }
    }),
  );

  // Recover (as PAUSED) and render any persisted run when the workspace already has loop state.
  if (vscode.workspace.workspaceFolders?.length) {
    void vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceFolder().uri, STATE_DIR, 'state.json')).then(
      () => getServices().catch(reportError),
      () => undefined,
    );
  }
}

export async function deactivate(): Promise<void> {
  if (!services) return;
  try {
    const s = await services;
    // Cancel in-flight requests and kill gate processes; the run stays resumable (PAUSED).
    await Promise.race([s.controller.interrupt(), new Promise((resolve) => setTimeout(resolve, 4000))]);
  } catch (error) {
    logger?.error(`Deactivate failed: ${String(error)}`);
  }
}
