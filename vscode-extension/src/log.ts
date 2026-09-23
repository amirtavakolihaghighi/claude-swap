import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Claude Swap');
  context.subscriptions.push(channel);
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function log(message: string): void {
  channel?.appendLine(`[${stamp()}] ${message}`);
}

export function logError(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  log(`ERROR (${context}): ${detail}`);
}

export function showLog(): void {
  channel?.show(true);
}
