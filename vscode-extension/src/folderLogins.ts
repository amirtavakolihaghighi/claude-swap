/**
 * Separate folder logins: Claude tabs in a chosen folder sign in to an account on
 * their own, while every other window keeps the main login.
 *
 * How: Anthropic's Claude extension can start Claude through a program named in
 * its `claudeCode.claudeProcessWrapper` setting. Claude Swap builds such a
 * launcher (launcher/claude-swap-launcher.cs) and points the setting at it. The
 * launcher reads folder-map.tsv on every Claude start and, for a listed folder,
 * sets CLAUDE_CONFIG_DIR to that folder's login folder. The Claude extension then
 * shows that login (sign-in prompt, history) in that window only, because it
 * follows the config home `claude auth status` reports.
 *
 * Why a separate SIGN-IN rather than a copy of Claude Swap's saved login: a login's
 * renewal ticket works once, so two places holding copies of one login break each
 * other at the first renewal (cswap's own README: "a second copy of the active
 * credential would go stale"). A separate sign-in has its own tickets, so the main
 * login and other windows can use the same account at the same time.
 *
 * The data root (%LOCALAPPDATA%\ClaudeSwapVSCode) holds:
 *   launcher\           the built launcher (see launcher.ts for why it lives here)
 *   bindings.json       the folders and their accounts (Claude Swap's own record)
 *   folder-map.tsv      the same, in the launcher's format
 *   logins\<id>\        one login folder per account (see loginFolders.ts)
 *   sessions\           what each running launcher wrote about itself
 *   windows\            what each open VS Code window wrote about itself
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  BindingsFile,
  FolderBinding,
  LoginVerdict,
  WindowRow,
  bindingFor,
  describeVerdict,
  folderContains,
  launcherMap,
  loginIdFor,
  loginVerdict,
  normalizeFolder,
  windowRows,
} from './folderMap';
import { dataRoot, installLauncher, launcherPath, writeAtomic } from './launcher';
import { log, logError, showLog } from './log';
import {
  deleteBeat,
  ensureLoginFolder,
  isAlive,
  mainClaudeConfigFile,
  mainClaudeHome,
  mirrorMcpServers,
  readBeats,
  readJsonFile,
  readLoginState,
  readSessions,
  removeTree,
  writeBeat,
} from './loginFolders';
import { Account } from './types';

const WRAPPER_SECTION = 'claudeCode';
const WRAPPER_KEY = 'claudeProcessWrapper';
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
/** How often this window tells the others it is open. */
const HEARTBEAT_MS = 15_000;
/** How often login folders are brought in step with the main setup. */
const SYNC_MS = 60_000;
const DAY_MS = 86_400_000;

export type HelpOpener = (section?: string) => void;

export class FolderLogins implements vscode.Disposable {
  readonly root = dataRoot();
  readonly loginsDir = path.join(this.root, 'logins');
  private readonly bindingsFile = path.join(this.root, 'bindings.json');
  private readonly mapFile = path.join(this.root, 'folder-map.tsv');
  private readonly sessionsDir = path.join(this.root, 'sessions');
  private readonly windowsDir = path.join(this.root, 'windows');
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private changeTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accounts: () => Account[],
    private readonly openHelp: HelpOpener
  ) {}

  /** Built for Windows: the launcher is a Windows program. */
  get supported(): boolean {
    return process.platform === 'win32';
  }

  /** Whether Anthropic's setting currently points at Claude Swap's launcher. */
  isOn(): boolean {
    const value = this.wrapperValue();
    return value !== undefined && samePath(value, launcherPath(this.root));
  }

  private wrapperValue(): string | undefined {
    const value = vscode.workspace.getConfiguration(WRAPPER_SECTION).inspect<string>(WRAPPER_KEY)?.globalValue;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (!this.supported) {
      this.updateContext().catch((err) => logError('context keys', err));
      return;
    }
    for (const dir of [this.sessionsDir, this.windowsDir, this.loginsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.beat();
    this.timers.push(setInterval(() => this.beat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.sync().catch((err) => logError('login folder sync', err)), SYNC_MS));
    for (const dir of [this.sessionsDir, this.windowsDir]) {
      try {
        this.watchers.push(fs.watch(dir, () => this.changed()));
      } catch (err) {
        logError(`watch ${dir}`, err);
      }
    }
    this.subscriptions.push(
      vscode.window.onDidChangeWindowState(() => this.beat()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.beat();
        this.updateContext().catch((err) => logError('context keys', err));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${WRAPPER_SECTION}.${WRAPPER_KEY}`)) {
          this.changed();
        }
      })
    );
    // Background work: a failure here is logged, never left as an unhandled rejection.
    this.repairLauncher().catch((err) => logError('launcher check', err));
    this.sync().catch((err) => logError('login folder sync', err));
    this.updateContext().catch((err) => logError('context keys', err));
  }

  dispose(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    if (this.supported) {
      deleteBeat(this.windowsDir, process.pid);
    }
    this.emitter.dispose();
  }

  /** Coalesce bursts of file events into one refresh of the views. */
  private changed(): void {
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.updateContext().catch((err) => logError('context keys', err));
      this.emitter.fire();
    }, 400);
  }

  private beat(): void {
    try {
      writeBeat(this.windowsDir, {
        hostPid: process.pid,
        name: vscode.workspace.name ?? 'Window without a folder',
        folders: this.thisWindowFolders(),
        focused: vscode.window.state.focused,
        updatedAt: Date.now(),
      });
    } catch (err) {
      logError('window heartbeat', err);
    }
  }

  private async updateContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'claudeSwap.folderLogins.supported', this.supported);
    await vscode.commands.executeCommand('setContext', 'claudeSwap.folderLogins.on', this.supported && this.isOn());
    await vscode.commands.executeCommand(
      'setContext',
      'claudeSwap.folderLogins.thisFolderSetUp',
      this.supported && this.thisWindowBinding() !== undefined
    );
  }

  /**
   * A new extension version may ship a changed launcher, and a deleted launcher
   * would stop Claude from starting anywhere. So whenever the feature is on,
   * rebuild if the source changed, and say so loudly if it cannot be done.
   */
  private async repairLauncher(): Promise<void> {
    if (!this.isOn()) {
      return;
    }
    try {
      const { rebuilt } = await installLauncher(this.launcherSource(), this.root);
      if (rebuilt) {
        log('launcher rebuilt for this extension version');
      }
    } catch (err) {
      logError('launcher rebuild', err);
      if (!fs.existsSync(launcherPath(this.root))) {
        const choice = await vscode.window.showErrorMessage(
          "Claude Swap: Claude cannot start in any window, because the launcher Claude Swap set up is missing and could not be rebuilt. Turning separate folder logins off makes Claude start normally again.",
          'Turn off separate folder logins',
          'Show logs'
        );
        if (choice === 'Turn off separate folder logins') {
          await this.clearSetting();
        } else if (choice === 'Show logs') {
          showLog();
        }
      }
    }
  }

  private launcherSource(): string {
    return this.context.asAbsolutePath(path.join('launcher', 'claude-swap-launcher.cs'));
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  bindings(): FolderBinding[] {
    const read = readJsonFile(this.bindingsFile);
    if (read.state !== 'ok') {
      return [];
    }
    const list = (read.value as Partial<BindingsFile>).bindings;
    return Array.isArray(list)
      ? list.filter((b): b is FolderBinding => typeof b?.folder === 'string' && typeof b?.loginId === 'string')
      : [];
  }

  private saveBindings(bindings: FolderBinding[]): void {
    const file: BindingsFile = { version: 1, bindings };
    writeAtomic(this.bindingsFile, JSON.stringify(file, null, 2));
    writeAtomic(this.mapFile, launcherMap(bindings, (id) => this.loginFolder(id)));
    this.changed();
  }

  loginFolder(loginId: string): string {
    return path.join(this.loginsDir, loginId);
  }

  rows(): WindowRow[] {
    if (!this.supported) {
      return [];
    }
    this.beat();
    return windowRows(
      readBeats(this.windowsDir),
      readSessions(this.sessionsDir),
      this.bindings(),
      process.pid,
      isAlive,
      Date.now()
    );
  }

  verdict(binding: FolderBinding): LoginVerdict {
    return loginVerdict(binding, readLoginState(this.loginFolder(binding.loginId)), Date.now());
  }

  thisWindowFolders(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  }

  thisWindowBinding(): FolderBinding | undefined {
    const bindings = this.bindings();
    return this.thisWindowFolders()
      .map((folder) => bindingFor(folder, bindings))
      .find((b) => b !== undefined);
  }

  /** One line for the status bar tooltip: which login Claude uses in this window. */
  windowNote(): string | undefined {
    if (!this.supported || !this.isOn()) {
      return undefined;
    }
    const binding = this.thisWindowBinding();
    if (!binding) {
      return 'Claude in this window uses the main login.';
    }
    return `Claude in this window uses its own login${accountLabel(binding)}: ${describeVerdict(this.verdict(binding), binding)}.`;
  }

  private liveSessionsOn(loginId: string): number {
    const folder = this.loginFolder(loginId);
    return readSessions(this.sessionsDir).filter((s) => s.loginFolder !== null && samePath(s.loginFolder, folder)).length;
  }

  // -------------------------------------------------------------------------
  // Turning the feature on and off
  // -------------------------------------------------------------------------

  /** Returns whether the feature is on afterwards. */
  async turnOn(options: { offerSetUp?: boolean } = {}): Promise<boolean> {
    if (!this.supported) {
      void vscode.window.showInformationMessage('Claude Swap: separate folder logins work on Windows only, for now.');
      return false;
    }
    if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
      void vscode.window.showErrorMessage(
        "Claude Swap: Anthropic's Claude Code extension is not installed, so there are no Claude tabs to give separate logins to."
      );
      return false;
    }
    if (this.isOn()) {
      return true;
    }
    const ours = launcherPath(this.root);
    const current = this.wrapperValue();
    if (current) {
      const replace = await vscode.window.showWarningMessage(
        'The Claude extension is already set to start Claude through another program.',
        {
          modal: true,
          detail:
            `Its "Claude Process Wrapper" setting is:\n${current}\n\n` +
            "Turning on separate folder logins replaces it with Claude Swap's launcher, and whatever that program does would stop happening.",
        },
        'Replace it'
      );
      if (replace !== 'Replace it') {
        return false;
      }
    }

    const choice = await vscode.window.showWarningMessage(
      'Turn on separate folder logins?',
      {
        modal: true,
        detail:
          'WHAT IT DOES\n' +
          "Claude Swap builds a small launcher program on this computer, using a compiler that is part of Windows, and tells Anthropic's Claude extension to start Claude through it. In a folder you set up, the launcher gives Claude that folder's own login. Everywhere else it changes nothing.\n\n" +
          'WHAT YOU WILL SEE\n' +
          'Nothing different yet. Then use "Use a Separate Login in This Folder" in the window of the project that should use another account.\n\n' +
          'GOOD TO KNOW\n' +
          '• This changes one Claude extension setting ("Claude Process Wrapper"), for all VS Code windows.\n' +
          '• Claude tabs already open keep running as they are; new tabs start through the launcher.\n' +
          "• With a launcher set, the Claude extension also lists sessions started by scripts and tools in its history, and skips a background check it runs after updating itself.\n" +
          '• Before you ever uninstall Claude Swap, turn this off. If you forget, Claude keeps working, and the setting can be cleared later in VS Code Settings.',
      },
      'Turn on',
      'Read the help first'
    );
    if (choice === 'Read the help first') {
      this.openHelp('separate-folder-logins');
      return false;
    }
    if (choice !== 'Turn on') {
      return false;
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Claude Swap: building the launcher…' },
        async () => {
          const { exe, rebuilt } = await installLauncher(this.launcherSource(), this.root);
          log(`launcher ${rebuilt ? 'built' : 'already up to date'}: ${exe}`);
        }
      );
      this.saveBindings(this.bindings());
      await vscode.workspace
        .getConfiguration(WRAPPER_SECTION)
        .update(WRAPPER_KEY, ours, vscode.ConfigurationTarget.Global);
    } catch (err) {
      logError('turn on separate folder logins', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window
        .showErrorMessage(`Claude Swap: separate folder logins could not be turned on. ${message}`, 'Show logs')
        .then((c) => c === 'Show logs' && showLog());
      return false;
    }
    log('separate folder logins turned on');
    this.changed();
    if (options.offerSetUp !== false) {
      const next = await vscode.window.showInformationMessage(
        'Claude Swap: separate folder logins are on. Folders you have not set up keep using your main login, exactly as before.',
        'Set up this folder now'
      );
      if (next === 'Set up this folder now') {
        await this.setUpFolder();
      }
    }
    return true;
  }

  async turnOff(): Promise<void> {
    if (!this.isOn()) {
      void vscode.window.showInformationMessage('Claude Swap: separate folder logins are already off.');
      return;
    }
    const bindings = this.bindings();
    const running = readSessions(this.sessionsDir).filter((s) => s.loginFolder !== null).length;
    const lines = [
      'WHAT IT DOES\nThe Claude extension goes back to starting Claude directly. New Claude tabs in every folder use your main login.',
    ];
    if (bindings.length > 0) {
      lines.push(
        `KEPT\nThe ${bindings.length === 1 ? 'folder you set up and its' : `${bindings.length} folders you set up and their`} separate login${bindings.length === 1 ? '' : 's'} are kept, so turning this on again restores them without signing in.\n\n"Turn off and forget" also deletes those separate logins; setting a folder up again would then mean signing in again. Conversations are not affected: they stay with your main setup.`
      );
    }
    if (running > 0) {
      lines.push(`STILL RUNNING\n${running} open Claude tab${running === 1 ? '' : 's'} using a separate login keep${running === 1 ? 's' : ''} it until closed.`);
    }
    const buttons = bindings.length > 0 ? ['Turn off', 'Turn off and forget'] : ['Turn off'];
    const choice = await vscode.window.showWarningMessage(
      'Turn off separate folder logins?',
      { modal: true, detail: lines.join('\n\n') },
      ...buttons
    );
    if (!choice) {
      return;
    }
    await this.clearSetting();
    if (choice === 'Turn off and forget') {
      const kept = this.forget(bindings);
      if (kept.length > 0) {
        void vscode.window.showWarningMessage(
          `Claude Swap: ${kept.length} separate login${kept.length === 1 ? ' was' : 's were'} kept because Claude is still using ${kept.length === 1 ? 'it' : 'them'}. Close those Claude tabs, then stop using the folder again to delete it.`
        );
      }
    }
    void vscode.window.showInformationMessage('Claude Swap: separate folder logins are off. New Claude tabs use your main login everywhere.');
  }

  private async clearSetting(): Promise<void> {
    if (this.isOn()) {
      await vscode.workspace.getConfiguration(WRAPPER_SECTION).update(WRAPPER_KEY, undefined, vscode.ConfigurationTarget.Global);
    }
    log('separate folder logins turned off');
    this.changed();
  }

  /** Remove bindings and delete their login folders; returns the login ids still in use. */
  private forget(bindings: FolderBinding[]): string[] {
    const ids = [...new Set(bindings.map((b) => b.loginId))];
    const kept: string[] = [];
    for (const id of ids) {
      if (this.liveSessionsOn(id) > 0) {
        kept.push(id);
        continue;
      }
      try {
        removeTree(this.loginFolder(id));
      } catch (err) {
        logError(`delete login folder ${id}`, err);
        kept.push(id);
      }
    }
    this.saveBindings(this.bindings().filter((b) => kept.includes(b.loginId)));
    return kept;
  }

  // -------------------------------------------------------------------------
  // Setting a folder up, and stopping
  // -------------------------------------------------------------------------

  async setUpFolder(): Promise<void> {
    if (!this.supported) {
      void vscode.window.showInformationMessage('Claude Swap: separate folder logins work on Windows only, for now.');
      return;
    }
    if (!this.isOn()) {
      const choice = await vscode.window.showInformationMessage(
        'Separate folder logins are off.',
        {
          modal: true,
          detail: 'A folder can only get its own login once they are on. Turn them on now? You will see exactly what that changes before anything happens.',
        },
        'Turn on'
      );
      if (choice !== 'Turn on' || !(await this.turnOn({ offerSetUp: false }))) {
        return;
      }
    }

    const folder = await this.pickThisWindowFolder();
    if (!folder) {
      return;
    }
    const accounts = this.accounts();
    type Item = vscode.QuickPickItem & { account?: Account };
    const items: Item[] = accounts.map((a) => ({
      label: `#${a.number} ${a.email}`,
      description: [a.alias, a.active ? 'the main login right now' : undefined].filter(Boolean).join(' · '),
      detail: 'Claude tabs in this folder sign in to this account on their own. Other windows can still use it too.',
      account: a,
    }));
    items.push({
      label: '$(account) Another account',
      description: 'not in Claude Swap',
      detail: 'Sign in with any account when Claude asks. Claude Swap then shows which one it was.',
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: `Separate login for "${path.basename(folder)}"`,
      placeHolder: 'Which account should Claude tabs in this folder use?',
      matchOnDescription: true,
    });
    if (!pick) {
      return;
    }

    const account = pick.account
      ? { email: pick.account.email, organizationUuid: pick.account.organizationUuid, number: pick.account.number }
      : undefined;
    const loginId = loginIdFor(account, folder);
    const loginDir = this.loginFolder(loginId);
    const signedIn = readLoginState(loginDir).hasCredentials;
    const sharing = this.bindings().filter((b) => b.loginId === loginId && !samePath(b.folder, folder));
    const who = account ? account.email : 'the account you want here';

    const seeLines = signedIn
      ? `This account already has a separate login${sharing.length ? ` (used by "${path.basename(sharing[0].folder)}")` : ''}, so no sign-in is needed.`
      : `The next Claude tab you open in this folder asks you to sign in. Sign in as ${who}, once, in the browser.`;
    const confirm = await vscode.window.showInformationMessage(
      `Use a separate login in "${path.basename(folder)}"?`,
      {
        modal: true,
        detail:
          'WHAT IT DOES\n' +
          `Claude tabs you open in this folder (and its subfolders) use their own login${account ? ` for #${account.number} ${account.email}` : ''} instead of your main login.\n\n` +
          `WHAT YOU WILL SEE\n${seeLines}\n\n` +
          'SHARED WITH YOUR OTHER WINDOWS\nConversations, Claude\'s notes about the project, your settings and hooks, CLAUDE.md and MCP servers.\n\n' +
          'KEPT SEPARATE\nThe login itself, and the skills and plugins claude.ai syncs to each account.\n\n' +
          'GOOD TO KNOW\n' +
          `• Other windows and the main login can use ${who} at the same time; they share its usage limits.\n` +
          '• This login lasts about 30 days. Then Claude in this folder asks you to sign in again, here.\n' +
          '• A setting you change inside this folder is replaced when your main settings change.',
      },
      'Set it up'
    );
    if (confirm !== 'Set it up') {
      return;
    }

    try {
      ensureLoginFolder(loginDir, mainClaudeHome(), log);
      if (this.liveSessionsOn(loginId) === 0) {
        mirrorMcpServers(loginDir, mainClaudeConfigFile());
      }
      const bindings = this.bindings().filter((b) => !samePath(b.folder, folder));
      bindings.push({ folder: normalizeFolder(folder), loginId, account, createdAt: new Date().toISOString() });
      this.saveBindings(bindings);
    } catch (err) {
      logError('set up separate login', err);
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window
        .showErrorMessage(`Claude Swap: the separate login could not be set up. ${message}`, 'Show logs')
        .then((c) => c === 'Show logs' && showLog());
      return;
    }
    log(`folder ${folder} now uses login ${loginId}${account ? ` (#${account.number})` : ''}`);

    const next = signedIn
      ? 'New Claude tabs in this folder use it straight away.'
      : `Next: open a new Claude tab in this window. Claude will ask you to sign in; sign in as ${who}.`;
    const choice = await vscode.window.showInformationMessage(
      `Claude Swap: "${path.basename(folder)}" now has its own login. ${next} Claude tabs already open here keep their current login until you close them. Reloading the window restarts them all, and they come back where they were.`,
      'Reload window now',
      'Later'
    );
    if (choice === 'Reload window now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  async stopFolder(target?: FolderBinding): Promise<void> {
    let binding = target;
    if (!binding) {
      const here = this.thisWindowFolders();
      const candidates = this.bindings().filter((b) => here.some((f) => folderContains(b.folder, f) || folderContains(f, b.folder)));
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('Claude Swap: no folder in this window has a separate login.');
        return;
      }
      if (candidates.length === 1) {
        binding = candidates[0];
      } else {
        const pick = await vscode.window.showQuickPick(
          candidates.map((b) => ({ label: path.basename(b.folder), description: b.folder, binding: b })),
          { placeHolder: 'Which folder should go back to the main login?' }
        );
        binding = pick?.binding;
      }
    }
    if (!binding) {
      return;
    }
    const chosen = binding;
    const name = path.basename(chosen.folder);
    const sharedBy = this.bindings().filter((b) => b.loginId === chosen.loginId && !samePath(b.folder, chosen.folder));
    const running = this.liveSessionsOn(chosen.loginId);
    const lines = [
      `WHAT IT DOES\nNew Claude tabs in "${name}" use your main login again.`,
      running > 0
        ? `STILL RUNNING\n${running} open Claude tab${running === 1 ? '' : 's'} on this login keep${running === 1 ? 's' : ''} it until closed.`
        : '',
      sharedBy.length > 0
        ? `KEPT\nThe separate login stays, because "${path.basename(sharedBy[0].folder)}" uses it too.`
        : 'KEPT\nThe separate login is kept, so setting this folder up again needs no sign-in. "Stop and delete its login" removes it instead; you would then sign in again next time. Conversations are not affected either way.',
    ].filter(Boolean);
    const canDelete = sharedBy.length === 0 && running === 0;
    const choice = await vscode.window.showWarningMessage(
      `Stop using the separate login in "${name}"?`,
      { modal: true, detail: lines.join('\n\n') },
      ...(canDelete ? ['Stop using it', 'Stop and delete its login'] : ['Stop using it'])
    );
    if (!choice) {
      return;
    }
    this.saveBindings(this.bindings().filter((b) => !samePath(b.folder, chosen.folder)));
    if (choice === 'Stop and delete its login') {
      try {
        removeTree(this.loginFolder(chosen.loginId));
      } catch (err) {
        logError('delete login folder', err);
        void vscode.window.showWarningMessage('Claude Swap: the folder is back on the main login, but its separate login could not be deleted. See the logs.');
      }
    }
    log(`folder ${chosen.folder} back on the main login`);
    void vscode.window.showInformationMessage(`Claude Swap: new Claude tabs in "${name}" use your main login again.`);
  }

  /** Bring another window to the front. VS Code never opens one folder in two windows, so this focuses it. */
  async goToWindow(row?: WindowRow): Promise<void> {
    const folder = row?.beat.folders[0];
    if (!folder) {
      void vscode.window.showInformationMessage('Claude Swap: that window has no folder open, so it cannot be brought forward from here.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
  }

  private async pickThisWindowFolder(): Promise<string | undefined> {
    const folders = this.thisWindowFolders();
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(
        'Claude Swap: open the project folder in this window first. A separate login belongs to a folder.'
      );
      return undefined;
    }
    if (folders.length === 1) {
      return folders[0];
    }
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: path.basename(f), description: f, folder: f })),
      { placeHolder: 'This window has several folders. Which one should get its own login?' }
    );
    return pick?.folder;
  }

  // -------------------------------------------------------------------------
  // Keeping login folders in step, and warnings
  // -------------------------------------------------------------------------

  private async sync(): Promise<void> {
    if (!this.supported) {
      return;
    }
    const bindings = this.bindings();
    for (const id of new Set(bindings.map((b) => b.loginId))) {
      const dir = this.loginFolder(id);
      try {
        ensureLoginFolder(dir, mainClaudeHome(), log);
        if (this.liveSessionsOn(id) === 0) {
          mirrorMcpServers(dir, mainClaudeConfigFile());
        }
      } catch (err) {
        logError(`keep login folder ${id} in step`, err);
      }
    }
    this.warn();
    this.changed();
  }

  /** Once a day per folder: a sign-in with the wrong account, or a login about to end. */
  private warn(): void {
    const binding = this.thisWindowBinding();
    if (!binding) {
      return;
    }
    const verdict = this.verdict(binding);
    const name = path.basename(binding.folder);
    const expiryDays = vscode.workspace.getConfiguration('claudeSwap').get<number>('warnLoginExpiryDays') ?? 3;
    if (verdict.kind === 'wrong-account' && this.firstTimeToday(`wrong:${binding.folder}`)) {
      void vscode.window.showWarningMessage(
        `Claude Swap: "${name}" is set to use ${verdict.expected}, but its Claude tab signed in as ${verdict.email}, so that is the account it uses now. To fix it: in a Claude tab in this window, sign out, then sign in as ${verdict.expected}. Signing out there does not affect other windows.`
      );
    } else if (
      verdict.kind === 'signed-in' &&
      verdict.daysLeft !== undefined &&
      expiryDays > 0 &&
      verdict.daysLeft <= expiryDays &&
      this.firstTimeToday(`expiry:${binding.folder}`)
    ) {
      void vscode.window.showWarningMessage(
        `Claude Swap: the separate login in "${name}" ends in ${verdict.daysLeft < 1 ? 'less than a day' : `${verdict.daysLeft} day${verdict.daysLeft === 1 ? '' : 's'}`}. When it does, Claude in this folder asks you to sign in again: sign in as ${verdict.email ?? 'the same account'}.`
      );
    }
  }

  private firstTimeToday(key: string): boolean {
    const stateKey = `folderLogins:said:${key}`;
    const last = this.context.globalState.get<number>(stateKey);
    if (last !== undefined && Date.now() - last < DAY_MS) {
      return false;
    }
    void this.context.globalState.update(stateKey, Date.now());
    return true;
  }
}

function accountLabel(binding: FolderBinding): string {
  return binding.account ? ` for #${binding.account.number ?? '?'} ${binding.account.email}` : '';
}

function samePath(a: string, b: string): boolean {
  return normalizeFolder(a).toLowerCase() === normalizeFolder(b).toLowerCase();
}
