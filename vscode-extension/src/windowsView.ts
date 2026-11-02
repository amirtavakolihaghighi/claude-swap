/**
 * The "Windows" view: every open VS Code window, which login its Claude tabs use,
 * whether a separate login is signed in, and how many Claude tabs run there. Each
 * window writes a small record about itself (folderLogins.ts), and every window's
 * view reads them all, so all views show the same picture.
 *
 * Every row carries a tooltip saying what it means and what to do about it. A row
 * the user is expected to act on carries the action itself.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { FolderLogins } from './folderLogins';
import { WindowRow, describeVerdict } from './folderMap';
import { Account } from './types';

type Node =
  | { kind: 'window'; row: WindowRow }
  | { kind: 'line'; text: string; icon: string; tooltip: string; command?: vscode.Command; contextValue?: string };

export class WindowsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly folderLogins: FolderLogins,
    private readonly mainAccount: () => Account | undefined
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return this.roots();
    }
    return element.kind === 'window' ? this.details(element.row) : [];
  }

  private roots(): Node[] {
    if (!this.folderLogins.supported) {
      return [
        line(
          'Separate folder logins are Windows-only for now',
          'info',
          'They rely on a small launcher program built with a compiler that comes with Windows. Every window uses the main login.'
        ),
      ];
    }
    const nodes: Node[] = [];
    if (!this.folderLogins.isOn()) {
      nodes.push(
        line(
          'Separate folder logins: off — click to learn more and turn on',
          'circle-slash',
          'While off, every window uses the main login. Turning on shows exactly what changes first, and you can cancel.',
          { command: 'claudeSwap.folderLogins.turnOn', title: 'Turn On Separate Folder Logins' }
        )
      );
    }
    for (const row of this.folderLogins.rows()) {
      nodes.push({ kind: 'window', row });
    }
    return nodes;
  }

  private details(row: WindowRow): Node[] {
    const out: Node[] = [];
    const on = this.folderLogins.isOn();
    const binding = on ? row.binding : undefined;
    if (binding) {
      const who = binding.account ? `#${binding.account.number ?? '?'} ${binding.account.email}` : 'whichever account you sign in with';
      out.push(
        line(
          `Claude uses its own login: ${who}`,
          'key',
          `Claude tabs in "${path.basename(binding.folder)}" sign in on their own, so they do not follow the main login when you switch accounts. Other windows can use the same account at the same time; they share its usage limits.`
        )
      );
      const verdict = this.folderLogins.verdict(binding);
      const icon = verdict.kind === 'signed-in' ? 'pass' : verdict.kind === 'not-signed-in' ? 'sign-in' : 'warning';
      const tips: Record<typeof verdict.kind, string> = {
        'signed-in': 'All set. A login lasts about 30 days; Claude Swap warns you a few days before it ends.',
        'not-signed-in': 'Open a new Claude tab in that window. Claude shows a sign-in screen; sign in in the browser. Only that folder is affected.',
        'wrong-account': 'That window\'s Claude signed in with a different account than the folder was set to, and uses it now. To fix it: in a Claude tab there, sign out, then sign in with the right account. Other windows are not affected.',
        expired: 'The login ended. The next Claude tab in that folder asks you to sign in again.',
      };
      out.push(line(describeVerdict(verdict, binding), icon, tips[verdict.kind]));
    } else {
      const main = this.mainAccount();
      out.push(
        line(
          `Claude uses the main login${main ? `: #${main.number} ${main.email}` : ''}`,
          'account',
          'The main login is the one Claude Swap switches. Every window without a separate login moves with it, on its next message.'
        )
      );
    }
    if (on) {
      const n = row.sessions.length;
      out.push(
        line(
          n === 0 ? 'No Claude tab running' : `${n} Claude ${n === 1 ? 'tab' : 'tabs'} running`,
          'pulse',
          'Counted from what the launcher records. Claude tabs opened before separate folder logins were turned on are not counted until they are reopened.'
        )
      );
    }
    if (row.isThisWindow) {
      if (row.binding && on) {
        out.push(
          line(
            'Stop using the separate login here…',
            'discard',
            'Shows what happens and asks before changing anything.',
            { command: 'claudeSwap.folderLogins.stop', title: 'Stop', arguments: [row.binding] }
          )
        );
      } else if (row.beat.folders.length > 0) {
        out.push(
          line(
            'Use a separate login in this folder…',
            'add',
            'Pick an account for this folder. Shows what happens and asks before changing anything.',
            { command: 'claudeSwap.folderLogins.setUp', title: 'Set up' }
          )
        );
      }
    } else if (row.beat.folders.length > 0) {
      out.push(
        line('Go to this window', 'arrow-right', 'Brings that window to the front.', {
          command: 'claudeSwap.goToWindow',
          title: 'Go to window',
          arguments: [row],
        })
      );
    }
    return out;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'line') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.tooltip = node.tooltip;
      item.command = node.command;
      item.contextValue = node.contextValue;
      return item;
    }
    const { row } = node;
    const on = this.folderLogins.isOn();
    const own = on && row.binding !== undefined;
    const item = new vscode.TreeItem(
      row.beat.name,
      row.isThisWindow ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    const parts = [row.isThisWindow ? 'this window' : undefined, own ? 'own login' : 'main login'];
    if (own && row.binding?.account?.number !== undefined) {
      parts[1] = `own login · #${row.binding.account.number}`;
    }
    item.description = parts.filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(own ? 'key' : row.beat.focused ? 'window' : 'empty-window');
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${row.beat.name}**${row.isThisWindow ? ' — this window' : ''}\n\n`);
    for (const folder of row.beat.folders) {
      tooltip.appendMarkdown(`\`${folder}\`\n\n`);
    }
    tooltip.appendMarkdown(
      own
        ? 'Claude tabs here use **their own login**, so switching accounts in Claude Swap does not move them.'
        : 'Claude tabs here use **the main login** and move with it when you switch accounts.'
    );
    item.tooltip = tooltip;
    item.contextValue = row.isThisWindow ? 'window.this' : 'window.other';
    return item;
  }
}

function line(text: string, icon: string, tooltip: string, command?: vscode.Command): Node {
  return { kind: 'line', text, icon, tooltip, command };
}
