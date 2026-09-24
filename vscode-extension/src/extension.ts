import * as vscode from 'vscode';
import { BurnRate } from './analysis';
import { AutoSwitcher } from './autoSwitch';
import * as cswap from './cswap';
import { CswapError, CswapNotFoundError } from './cswap';
import { UsageHistory } from './history';
import { LeaderLease } from './leader';
import { initLog, log, logError, showLog } from './log';
import { Notices } from './notices';
import { StatusBar, describeBurnRate, effectiveUsage } from './statusBar';
import { AccountsTreeProvider } from './treeView';
import { Account, ListPayload } from './types';

/** Fallback when claude-swap's configured threshold cannot be read. */
const DEFAULT_THRESHOLD = 90;

let statusBar: StatusBar;
let notices: Notices;
let autoSwitcher: AutoSwitcher;
let history: UsageHistory;
let tree: AccountsTreeProvider;
let refreshTimer: NodeJS.Timeout | undefined;
let lastPayload: ListPayload | undefined;
let threshold: number | undefined;
let refreshing = false;

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log('Claude Swap extension activating');

  statusBar = new StatusBar();
  notices = new Notices(context);
  history = new UsageHistory(context);
  tree = new AccountsTreeProvider();
  autoSwitcher = new AutoSwitcher(() => void refresh(), new LeaderLease(context));

  context.subscriptions.push(
    statusBar,
    autoSwitcher,
    vscode.window.registerTreeDataProvider('claudeSwap.accounts', tree),
    vscode.commands.registerCommand('claudeSwap.refresh', () => refresh(true)),
    vscode.commands.registerCommand('claudeSwap.switchAccount', switchAccount),
    vscode.commands.registerCommand('claudeSwap.switchBest', switchBest),
    vscode.commands.registerCommand('claudeSwap.switchToAccount', (target?: string) =>
      target ? performSwitch(target) : switchAccount()
    ),
    vscode.commands.registerCommand('claudeSwap.rescue', rescue),
    vscode.commands.registerCommand('claudeSwap.toggleAutoSwitch', toggleAutoSwitch),
    vscode.commands.registerCommand('claudeSwap.bindFolder', bindFolder),
    vscode.commands.registerCommand('claudeSwap.openDashboard', openDashboard),
    vscode.commands.registerCommand('claudeSwap.showLogs', () => showLog()),
    vscode.commands.registerCommand('claudeSwap.showBurnRate', showBurnRate),
    vscode.commands.registerCommand('claudeSwap.clearHistory', clearHistory),
    vscode.workspace.onDidChangeConfiguration(onConfigChange)
  );

  restartRefreshTimer();
  autoSwitcher.sync();
  void refresh();
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}

function onConfigChange(event: vscode.ConfigurationChangeEvent): void {
  if (event.affectsConfiguration('claudeSwap.executablePath')) {
    cswap.resetExecutableCache();
    void refresh();
  }
  if (event.affectsConfiguration('claudeSwap.refreshIntervalSeconds')) {
    restartRefreshTimer();
  }
  if (event.affectsConfiguration('claudeSwap.autoSwitch')) {
    autoSwitcher.sync();
    render();
  }
}

function restartRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const seconds = Math.max(
    15,
    vscode.workspace.getConfiguration('claudeSwap').get<number>('refreshIntervalSeconds') ?? 60
  );
  refreshTimer = setInterval(() => void refresh(), seconds * 1000);
  log(`status bar refresh every ${seconds}s`);
}

/** Burn rate per account number, recomputed from stored history on each render. */
function currentRates(): Map<number, BurnRate | undefined> {
  const rates = new Map<number, BurnRate | undefined>();
  for (const account of lastPayload?.accounts ?? []) {
    rates.set(account.number, history.burnRate(account));
  }
  return rates;
}

function render(): void {
  const rates = currentRates();
  statusBar.render({
    payload: lastPayload,
    autoSwitchEnabled: autoSwitcher.enabled,
    threshold,
    lastUpdated: lastPayload ? new Date() : undefined,
    rates,
  });
  tree.update(lastPayload, rates);
}

/**
 * Refresh the account list. `interactive` means the user asked directly, so
 * failures are surfaced as notifications rather than only logged — a background
 * tick that fails because the laptop is offline should not pop a dialog.
 */
async function refresh(interactive = false): Promise<void> {
  if (refreshing) {
    return;
  }
  refreshing = true;
  try {
    if (threshold === undefined) {
      threshold = await cswap.autoSwitchThreshold();
    }
    const payload = await cswap.list();
    lastPayload = payload;
    // Record before rendering, so a newly-taken sample is available to the rate
    // shown in this same pass rather than lagging one refresh behind.
    history.observe(payload.accounts);
    render();
    notices.check(payload, threshold ?? DEFAULT_THRESHOLD);
  } catch (err) {
    handleFailure(err, interactive);
  } finally {
    refreshing = false;
  }
}

function handleFailure(err: unknown, interactive: boolean): void {
  logError('refresh', err);

  if (err instanceof CswapNotFoundError) {
    const message = 'cswap was not found. Click to set its location.';
    statusBar.render({ error: message, autoSwitchEnabled: false });
    tree.update(undefined, new Map(), message);
    log(`searched: ${err.searched.join(', ')}`);
    void vscode.window
      .showErrorMessage(
        'Claude Swap: could not find the cswap command.',
        'Set path…',
        'Show logs'
      )
      .then((choice) => {
        if (choice === 'Set path…') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'claudeSwap.executablePath'
          );
        } else if (choice === 'Show logs') {
          showLog();
        }
      });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  statusBar.render({ error: message, autoSwitchEnabled: autoSwitcher.enabled, threshold });
  tree.update(lastPayload, currentRates(), message);
  if (interactive) {
    void vscode.window.showErrorMessage(`Claude Swap: ${message}`, 'Show logs').then((choice) => {
      if (choice === 'Show logs') {
        showLog();
      }
    });
  }
}

function accountDetail(account: Account): string {
  const effective = effectiveUsage(account);
  if (!effective) {
    return account.usageStatus.replace(/_/g, ' ');
  }
  const parts: string[] = [];
  const five = effective.usage.fiveHour;
  const seven = effective.usage.sevenDay;
  if (five) {
    parts.push(`5h ${Math.round(five.pct)}%${five.countdown ? ` (resets in ${five.countdown})` : ''}`);
  }
  if (seven) {
    let text = `7d ${Math.round(seven.pct)}%`;
    if (seven.aheadOfPace) {
      text += ' — ahead of pace';
    }
    parts.push(text);
  }
  if (effective.stale) {
    parts.push('last known numbers');
  }
  return parts.join('   ·   ');
}

interface AccountPick extends vscode.QuickPickItem {
  target?: string;
  best?: boolean;
}

async function switchAccount(): Promise<void> {
  if (!lastPayload) {
    await refresh(true);
  }
  const payload = lastPayload;
  if (!payload || payload.accounts.length === 0) {
    void vscode.window.showInformationMessage(
      'Claude Swap: no accounts are managed yet. Log into Claude Code, then run "cswap add" in a terminal.'
    );
    return;
  }

  const items: AccountPick[] = [
    {
      label: '$(rocket) Account with the most quota left',
      description: 'let claude-swap choose',
      best: true,
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
  ];

  for (const account of payload.accounts) {
    const flags: string[] = [];
    if (account.active) {
      flags.push('active');
    }
    if (account.disabled) {
      flags.push('disabled');
    }
    items.push({
      label: `${account.active ? '$(check)' : '$(circle-outline)'} #${account.number} ${account.email}`,
      description: [account.alias, ...flags].filter(Boolean).join(' · '),
      detail: `　　${accountDetail(account)}`,
      target: String(account.number),
    });
  }

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Switch Claude Code account',
    placeHolder: 'Your conversations are not affected — history stays where it is',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!choice) {
    return;
  }
  await performSwitch(choice.best ? undefined : choice.target);
}

async function switchBest(): Promise<void> {
  await performSwitch(undefined);
}

/** `target` undefined means "whichever account has the most quota left". */
async function performSwitch(target: string | undefined): Promise<void> {
  statusBar.setBusy('Switching…');
  try {
    const result = target === undefined ? await cswap.switchBest() : await cswap.switchTo(target);
    log(`switch result: ${JSON.stringify(result)}`);

    for (const warning of result.warnings ?? []) {
      void vscode.window.showWarningMessage(`Claude Swap: ${warning}`);
    }

    await refresh();

    if (!result.switched) {
      void vscode.window.showInformationMessage(`Claude Swap: ${result.message}`);
      return;
    }

    // On Windows and Linux the credential is a file and Claude Code re-reads it,
    // so the new account is live on the next message with no restart. Reloading
    // is only for applying it to an already-open Claude tab immediately.
    const choice = await vscode.window.showInformationMessage(
      `${result.message}. Active on your next message — reload to apply to an open Claude tab now.`,
      'Reload window',
      'OK'
    );
    if (choice === 'Reload window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err) {
    logError('switch', err);
    const message = err instanceof CswapError ? err.message : String(err);
    void vscode.window.showErrorMessage(`Claude Swap: switch failed — ${message}`, 'Show logs').then(
      (choice) => {
        if (choice === 'Show logs') {
          showLog();
        }
      }
    );
    render();
  }
}

/**
 * The "I just got cut off mid-conversation" button: move to the best account and
 * reload, so the open Claude tab picks up the new login immediately and the
 * conversation can be resumed.
 */
async function rescue(): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    'Switch to the account with the most quota left and reload this window?',
    { modal: true, detail: 'Your conversation history is not touched. After the reload, use Resume to continue where you left off.' },
    'Switch and reload'
  );
  if (confirmed !== 'Switch and reload') {
    return;
  }
  statusBar.setBusy('Switching…');
  try {
    const result = await cswap.switchBest();
    log(`rescue switch: ${JSON.stringify(result)}`);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (err) {
    logError('rescue', err);
    void vscode.window.showErrorMessage(
      `Claude Swap: could not switch — ${err instanceof Error ? err.message : String(err)}`
    );
    render();
  }
}

async function toggleAutoSwitch(): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeSwap');
  const next = !(config.get<boolean>('autoSwitch.enabled') ?? false);
  await config.update('autoSwitch.enabled', next, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    next
      ? `Claude Swap: background auto-switch is on. It will move you off an account at ${
          threshold !== undefined ? `${Math.round(threshold)}%` : 'the configured threshold'
        }.`
      : 'Claude Swap: background auto-switch is off.'
  );
}

async function bindFolder(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showInformationMessage('Claude Swap: open a folder first.');
    return;
  }
  if (!lastPayload) {
    await refresh(true);
  }
  const payload = lastPayload;
  if (!payload || payload.accounts.length === 0) {
    void vscode.window.showInformationMessage('Claude Swap: no accounts are managed yet.');
    return;
  }

  const folder =
    folders.length === 1
      ? folders[0]
      : (
          await vscode.window.showQuickPick(
            folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
            { title: 'Which folder?' }
          )
        )?.folder;
  if (!folder) {
    return;
  }

  const pick = await vscode.window.showQuickPick(
    payload.accounts.map((a) => ({
      label: `#${a.number} ${a.email}`,
      description: a.alias,
      target: String(a.number),
    })),
    { title: `Bind ${folder.name} to which account?` }
  );
  if (!pick) {
    return;
  }

  try {
    await cswap.mapDirectory(pick.target, folder.uri.fsPath);
    void vscode.window.showInformationMessage(
      `Claude Swap: ${folder.name} is now bound to account ${pick.label}. ` +
        'Running "cswap run" in this folder launches that account.'
    );
  } catch (err) {
    logError('bindFolder', err);
    void vscode.window.showErrorMessage(
      `Claude Swap: could not bind folder — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * "Can I start a long task right now?" — the burn-rate answer in one place.
 *
 * Shown as a modal because it is asked deliberately, and because the answer is an
 * estimate that deserves its caveat read rather than glimpsed in a corner.
 */
async function showBurnRate(): Promise<void> {
  if (!lastPayload) {
    await refresh(true);
  }
  const payload = lastPayload;
  if (!payload || payload.accounts.length === 0) {
    void vscode.window.showInformationMessage('Claude Swap: no accounts are managed yet.');
    return;
  }

  const lines: string[] = [];
  for (const account of payload.accounts) {
    const rate = history.burnRate(account);
    const described = describeBurnRate(rate);
    if (described) {
      lines.push(`#${account.number} ${account.email}\n    ${described}`);
    } else {
      const have = history.sampleCount(account);
      lines.push(
        `#${account.number} ${account.email}\n` +
          `    not enough history yet (${have} reading${have === 1 ? '' : 's'} so far)`
      );
    }
  }

  void vscode.window.showInformationMessage(
    'How fast is your 5-hour quota going?',
    {
      modal: true,
      detail:
        lines.join('\n\n') +
        '\n\nEstimated from readings taken on this machine while VS Code was open, ' +
        'so it reflects your own recent pace rather than a published figure. ' +
        'Usage from other machines is included in the percentages but not in the rate.',
    },
    'OK'
  );
}

async function clearHistory(): Promise<void> {
  if (!lastPayload) {
    await refresh(true);
  }
  history.clear(lastPayload?.accounts ?? []);
  log('usage history cleared');
  render();
  void vscode.window.showInformationMessage(
    'Claude Swap: usage history cleared. Burn-rate estimates will rebuild over the next hour.'
  );
}

function openDashboard(): void {
  try {
    const bin = cswap.resolveExecutable();
    // Run cswap as the terminal's own process rather than typing a command into
    // a shell: no quoting to get right, and it works the same whether the user's
    // default terminal is PowerShell, cmd, bash or zsh.
    const terminal = vscode.window.createTerminal({
      name: 'Claude Swap',
      shellPath: bin,
      shellArgs: ['watch'],
    });
    terminal.show();
  } catch (err) {
    handleFailure(err, true);
  }
}
