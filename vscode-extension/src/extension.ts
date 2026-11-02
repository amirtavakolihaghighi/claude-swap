import * as vscode from 'vscode';
import {
  BurnRate,
  SaveLoginPlan,
  afterSwitchNotice,
  describeRefresh,
  saveLoginPlan,
} from './analysis';
import { AutoSwitcher } from './autoSwitch';
import * as cswap from './cswap';
import { CswapError, CswapNotFoundError } from './cswap';
import { FolderLogins } from './folderLogins';
import { WindowRow } from './folderMap';
import { UsageHistory } from './history';
import { LeaderLease } from './leader';
import { initLog, log, logError, showLog } from './log';
import { Notices } from './notices';
import { StatusBar, describeBurnRate, effectiveUsage } from './statusBar';
import { AccountsTreeProvider } from './treeView';
import { Account, ListPayload } from './types';
import { WindowsTreeProvider } from './windowsView';

/** Fallback when claude-swap's configured threshold cannot be read. */
const DEFAULT_THRESHOLD = 90;

let statusBar: StatusBar;
let notices: Notices;
let autoSwitcher: AutoSwitcher;
let history: UsageHistory;
let tree: AccountsTreeProvider;
let folderLogins: FolderLogins;
let windowsTree: WindowsTreeProvider;
let extensionUri: vscode.Uri;
let refreshTimer: NodeJS.Timeout | undefined;
let lastPayload: ListPayload | undefined;
let threshold: number | undefined;

type LoadResult = { ok: true } | { ok: false; error: unknown };
let inFlight: Promise<LoadResult> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log('Claude Swap extension activating');

  statusBar = new StatusBar();
  notices = new Notices(context);
  history = new UsageHistory(context);
  tree = new AccountsTreeProvider();
  autoSwitcher = new AutoSwitcher(() => void refresh(), new LeaderLease(context));
  extensionUri = context.extensionUri;
  folderLogins = new FolderLogins(context, () => lastPayload?.accounts ?? [], openHelp);
  windowsTree = new WindowsTreeProvider(folderLogins, () => lastPayload?.accounts.find((a) => a.active));
  const windowsView = vscode.window.createTreeView('claudeSwap.windows', { treeDataProvider: windowsTree });
  // Other windows open and close without telling this one, so re-read while visible.
  const windowsTimer = setInterval(() => windowsView.visible && windowsTree.refresh(), 10_000);

  context.subscriptions.push(
    statusBar,
    autoSwitcher,
    folderLogins,
    windowsView,
    { dispose: () => clearInterval(windowsTimer) },
    folderLogins.onDidChange(() => {
      windowsTree.refresh();
      if (lastPayload) {
        render(); // the tooltip names this window's login; no data yet means nothing to redraw
      }
    }),
    windowsView.onDidChangeVisibility(() => windowsView.visible && windowsTree.refresh()),
    vscode.window.registerTreeDataProvider('claudeSwap.accounts', tree),
    vscode.commands.registerCommand('claudeSwap.help', (section?: string) => openHelp(section)),
    vscode.commands.registerCommand('claudeSwap.folderLogins.turnOn', () => folderLogins.turnOn()),
    vscode.commands.registerCommand('claudeSwap.folderLogins.turnOff', () => folderLogins.turnOff()),
    vscode.commands.registerCommand('claudeSwap.folderLogins.setUp', () => folderLogins.setUpFolder()),
    vscode.commands.registerCommand('claudeSwap.folderLogins.stop', (binding?: unknown) =>
      folderLogins.stopFolder(isBinding(binding) ? binding : undefined)
    ),
    // The "Go to this window" line passes the row; the inline button passes its tree node.
    vscode.commands.registerCommand('claudeSwap.goToWindow', (arg?: WindowRow | { row?: WindowRow }) =>
      folderLogins.goToWindow(arg && 'row' in arg ? arg.row : (arg as WindowRow | undefined))
    ),
    vscode.commands.registerCommand('claudeSwap.windows.refresh', () => windowsTree.refresh()),
    vscode.commands.registerCommand('claudeSwap.refresh', () => refresh(true, true)),
    vscode.commands.registerCommand('claudeSwap.saveLogin', saveLogin),
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
  folderLogins.start();
  void refresh();
}

/**
 * The help page (HELP.md), shown as a formatted preview. `section` scrolls to a
 * heading where the preview supports it; the page opens either way.
 */
function openHelp(section?: string): void {
  const uri = vscode.Uri.joinPath(extensionUri, 'HELP.md');
  void vscode.commands.executeCommand('markdown.showPreview', section ? uri.with({ fragment: section }) : uri);
}

function isBinding(value: unknown): value is import('./folderMap').FolderBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { folder?: unknown }).folder === 'string' &&
    typeof (value as { loginId?: unknown }).loginId === 'string'
  );
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
    windowNote: folderLogins.windowNote(),
  });
  tree.update(lastPayload, rates);
}

/**
 * Refresh the account list. `interactive` means the user asked directly, so
 * failures are surfaced as notifications rather than only logged — a background
 * tick that fails because the laptop is offline should not pop a dialog.
 * `report` (the Refresh command only) also says what was found, even when no
 * number changed, because a click that changes nothing on screen reads as a click
 * that did nothing. Commands that merely need data loaded first pass `interactive`
 * alone: a usage summary popping up over the account picker answers nothing.
 *
 * A click while a refresh is already running joins it. It used to return at once
 * without a word, which was one way "Refresh does nothing" happened: a `cswap list`
 * waiting out a network timeout can take many seconds.
 */
async function refresh(interactive = false, report = false): Promise<void> {
  if (interactive) {
    statusBar.setBusy('Checking usage…');
  } else if (inFlight) {
    return; // a background tick adds nothing to a refresh that is already running
  }
  if (!inFlight) {
    inFlight = load().finally(() => {
      inFlight = undefined;
    });
  }
  const result = await inFlight;
  if (!result.ok) {
    handleFailure(result.error, interactive);
    return;
  }
  if (interactive) {
    render(); // clears the busy text, whichever caller started the load
  }
  if (report && lastPayload) {
    void vscode.window.showInformationMessage(
      `Claude Swap: ${describeRefresh(lastPayload.accounts, Date.now())}`
    );
  }
}

/** One `cswap list`, recorded and rendered. Never throws: callers report the failure. */
async function load(): Promise<LoadResult> {
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
    void notices.checkSignIns(payload, cswap.status);
    return { ok: true };
  } catch (err) {
    logError('refresh', err); // here, not in handleFailure: a joined load fails once
    return { ok: false, error: err };
  }
}

function handleFailure(err: unknown, interactive: boolean): void {
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
    const choice = await vscode.window.showInformationMessage(
      'Claude Swap: no accounts are managed yet. Sign in to Claude Code, then save that login.',
      'Save current login'
    );
    if (choice === 'Save current login') {
      await saveLogin();
    }
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

    // Reload is offered only where it changes something (macOS); see afterSwitchNotice.
    const notice = afterSwitchNotice(process.platform);
    const text = `${result.message}. ${notice.note}`;
    if (!notice.offerReload) {
      void vscode.window.showInformationMessage(text);
      return;
    }
    const choice = await vscode.window.showInformationMessage(text, 'Reload window');
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

/**
 * Save Claude Code's current login into claude-swap: `cswap add` with no slot, which
 * updates the signed-in account in place, or adds it when claude-swap does not know
 * it, and refuses a login that does not belong to the signed-in account. It is the
 * step cswap's own instructions give after signing in again ("/login, then cswap
 * add"), minus the terminal. `confirmed` skips the "add a new account?" question
 * when the user has just answered it in an offer from Notices.
 */
async function saveLogin(options?: { confirmed?: boolean }): Promise<void> {
  let plan: SaveLoginPlan;
  try {
    plan = saveLoginPlan((await cswap.status()).active);
  } catch (err) {
    reportSaveFailure(err);
    return;
  }
  if (plan.kind === 'not-signed-in') {
    void vscode.window.showInformationMessage(
      'Claude Swap: Claude Code is not signed in. Sign in in a Claude tab first, then save the login.'
    );
    return;
  }
  if (plan.kind === 'add' && !options?.confirmed) {
    const choice = await vscode.window.showInformationMessage(
      `Add ${plan.email} to Claude Swap?`,
      {
        modal: true,
        detail:
          "Claude Code is signed in with an account Claude Swap doesn't know yet. " +
          'Adding it lets you switch to it and see its usage.',
      },
      'Add account'
    );
    if (choice !== 'Add account') {
      return;
    }
  }

  statusBar.setBusy('Saving login…');
  try {
    await cswap.saveCurrentLogin();
  } catch (err) {
    reportSaveFailure(err);
    await refresh();
    return;
  }
  if (plan.kind === 'update') {
    void vscode.window.showInformationMessage(
      `Claude Swap: saved the current login for #${plan.number} (${plan.email}). ` +
        `Switching back to #${plan.number} will use it.`
    );
  } else {
    // Only cswap knows which slot it chose; ask, but a failure here is not a
    // failure of the save that already succeeded.
    const added = await cswap.status().then((s) => saveLoginPlan(s.active), () => undefined);
    const slot = added?.kind === 'update' ? ` as account #${added.number}` : '';
    void vscode.window.showInformationMessage(`Claude Swap: added ${plan.email}${slot}.`);
  }
  await refresh();
}

function reportSaveFailure(err: unknown): void {
  logError('save login', err);
  const message = err instanceof Error ? err.message : String(err);
  void vscode.window
    .showErrorMessage(`Claude Swap: could not save the login — ${message}`, 'Show logs')
    .then((choice) => {
      if (choice === 'Show logs') {
        showLog();
      }
    });
  render();
}

async function toggleAutoSwitch(): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeSwap');
  const next = !(config.get<boolean>('autoSwitch.enabled') ?? false);
  if (next) {
    // Turning it on is the side with consequences: switches start happening
    // without a click, and every window on the main login moves with them.
    const confirmed = await vscode.window.showInformationMessage(
      'Turn on background auto-switch?',
      {
        modal: true,
        detail:
          'WHAT IT DOES\n' +
          `Claude Swap checks regularly and, when the active account nears ${
            threshold !== undefined ? `${Math.round(threshold)}%` : 'its limit'
          }, switches the main login to the account with the most room.\n\n` +
          'WHAT YOU WILL SEE\nA notification each time it switches (unless turned off in Settings).\n\n' +
          'GOOD TO KNOW\n' +
          '• It moves every window that uses the main login. Folders with their own login are not affected.\n' +
          '• Only one VS Code window runs the check, however many are open.\n' +
          '• Turn it off the same way, at any time.',
      },
      'Turn on'
    );
    if (confirmed !== 'Turn on') {
      return;
    }
  }
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
  const confirmed = await vscode.window.showWarningMessage(
    'Clear usage history?',
    {
      modal: true,
      detail:
        'WHAT IT DOES\nDeletes the usage readings this computer has recorded for the "How fast am I using quota?" estimates. Your accounts, logins and usage limits are not touched.\n\n' +
        'GOOD TO KNOW\nThis cannot be undone. Estimates show "not enough history yet" until about an hour of new readings has built up.',
    },
    'Clear history'
  );
  if (confirmed !== 'Clear history') {
    return;
  }
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
