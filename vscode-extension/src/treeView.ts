/**
 * The sidebar panel: every account with a usage bar, expandable to its windows.
 *
 * A TreeView rather than a webview, deliberately. A webview would allow prettier
 * bars, but it also means owning HTML, a content-security policy, theme variables
 * and message passing — and it would not look native. Unicode block characters
 * give a perfectly readable bar inside a normal tree item, inherit the user's
 * theme for free, and let each row carry real VS Code affordances (icons,
 * tooltips, a click action, context menus).
 */

import * as vscode from 'vscode';
import {
  BurnRate,
  bindingWindow,
  effectiveUsage,
  hiddenModelConstraint,
} from './analysis';
import { STATUS_LABELS, describeBurnRate, daysUntil, pct } from './statusBar';
import { Account, ListPayload, UsageWindow } from './types';

const BAR_WIDTH = 12;
const PCT_DANGER = 90;
const PCT_WARN = 75;

/** `████████░░░░` — filled proportion of a window. */
function bar(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function severityIcon(value: number): vscode.ThemeIcon {
  if (value >= PCT_DANGER) {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  }
  if (value >= PCT_WARN) {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
  }
  return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
}

type Node = AccountNode | WindowNode | NoteNode;

class AccountNode {
  readonly kind = 'account';
  constructor(readonly account: Account, readonly rate: BurnRate | undefined) {}
}

class WindowNode {
  readonly kind = 'window';
  constructor(
    readonly label: string,
    readonly window: UsageWindow,
    readonly isRealLimit: boolean
  ) {}
}

class NoteNode {
  readonly kind = 'note';
  constructor(
    readonly text: string,
    readonly icon?: string,
    readonly tooltip?: string
  ) {}
}

export class AccountsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private payload: ListPayload | undefined;
  private rates: Map<number, BurnRate | undefined> = new Map();
  private error: string | undefined;

  update(
    payload: ListPayload | undefined,
    rates: Map<number, BurnRate | undefined>,
    error?: string
  ): void {
    this.payload = payload;
    this.rates = rates;
    this.error = error;
    this.emitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      if (this.error) {
        return [new NoteNode(this.error, 'alert')];
      }
      if (!this.payload || this.payload.accounts.length === 0) {
        return [
          new NoteNode('No accounts managed yet', 'info'),
          new NoteNode('Run "cswap add" in a terminal', 'terminal'),
        ];
      }
      return this.payload.accounts.map(
        (a) => new AccountNode(a, this.rates.get(a.number))
      );
    }

    if (element.kind !== 'account') {
      return [];
    }
    return this.accountChildren(element);
  }

  private accountChildren(node: AccountNode): Node[] {
    const { account, rate } = node;
    const effective = effectiveUsage(account);
    if (!effective) {
      const children: Node[] = [
        new NoteNode(STATUS_LABELS[account.usageStatus] ?? account.usageStatus, 'circle-slash'),
      ];
      if (account.usageError) {
        children.push(new NoteNode(`last fetch failed: ${account.usageError}`, 'debug-disconnect'));
      }
      return children;
    }

    const { usage, stale } = effective;
    const hidden = hiddenModelConstraint(usage);
    const children: Node[] = [];

    if (usage.fiveHour) {
      children.push(new WindowNode('5-hour', usage.fiveHour, false));
    }
    if (usage.sevenDay) {
      children.push(new WindowNode('Weekly', usage.sevenDay, false));
    }
    for (const scoped of usage.scoped ?? []) {
      children.push(new WindowNode(scoped.name ?? 'model', scoped, scoped === hidden));
    }

    const burn = describeBurnRate(rate);
    if (burn) {
      children.push(new NoteNode(burn, 'pulse', 'Estimated from usage observed on this machine'));
    }

    if (usage.sevenDay?.willLastToReset === false) {
      children.push(
        new NoteNode('Projected to run out before the weekly reset', 'warning',
          'A rough linear projection, not a certainty')
      );
    }
    if (stale) {
      children.push(new NoteNode('Showing last known numbers', 'history'));
    }
    if (account.loginExpiresAt) {
      const days = daysUntil(account.loginExpiresAt);
      if (days !== undefined && days < 7) {
        const when = days < 1 ? 'less than a day' : `${Math.floor(days)} days`;
        children.push(
          new NoteNode(`Login expires in ${when}`, 'key',
            `Run /login as this account, then: cswap add --slot ${account.number}`)
        );
      }
    }
    return children;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'account') {
      return this.accountItem(node);
    }
    if (node.kind === 'window') {
      return this.windowItem(node);
    }
    const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    if (node.icon) {
      item.iconPath = new vscode.ThemeIcon(node.icon);
    }
    if (node.tooltip) {
      item.tooltip = node.tooltip;
    }
    return item;
  }

  private accountItem(node: AccountNode): vscode.TreeItem {
    const { account } = node;
    const effective = effectiveUsage(account);
    const binding = effective ? bindingWindow(effective.usage) : undefined;

    const item = new vscode.TreeItem(
      `#${account.number}  ${account.email}`,
      vscode.TreeItemCollapsibleState.Expanded
    );

    if (binding) {
      item.description = `${bar(binding.window.pct)} ${pct(binding.window.pct)} ${binding.label}`;
      item.iconPath = account.active
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
        : severityIcon(binding.window.pct);
    } else {
      item.description = STATUS_LABELS[account.usageStatus] ?? account.usageStatus;
      item.iconPath = new vscode.ThemeIcon('circle-outline');
    }

    const flags: string[] = [];
    if (account.active) {
      flags.push('active');
    }
    if (account.disabled) {
      flags.push('disabled');
    }
    if (account.alias) {
      flags.push(`alias: ${account.alias}`);
    }
    item.tooltip = flags.length
      ? `${account.email} — ${flags.join(', ')}`
      : account.email;

    // Drives the inline switch button and the right-click menu (see package.json).
    item.contextValue = account.active ? 'activeAccount' : 'switchableAccount';
    if (!account.active) {
      item.command = {
        command: 'claudeSwap.switchToAccount',
        title: 'Switch to this account',
        arguments: [String(account.number)],
      };
    }
    return item;
  }

  private windowItem(node: WindowNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    const bits = [bar(node.window.pct), pct(node.window.pct)];
    if (node.window.countdown) {
      bits.push(`· ${node.window.countdown}`);
    }
    if (node.window.aheadOfPace) {
      bits.push('· ahead of pace');
    }
    item.description = bits.join(' ');
    item.iconPath = severityIcon(node.window.pct);

    const tips: string[] = [];
    if (node.window.clock) {
      tips.push(`Resets ${node.window.clock}`);
    }
    if (node.window.expectedPct !== undefined) {
      tips.push(`Even pace would be ~${Math.round(node.window.expectedPct)}%`);
    }
    if (node.isRealLimit) {
      tips.push('This per-model limit is further along than your account limits — it is what will actually stop you.');
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'));
    }
    if (tips.length) {
      item.tooltip = tips.join('\n');
    }
    return item;
  }
}
