/** Rendering of the status bar item and its hover tooltip. */

import * as vscode from 'vscode';
import { Account, ListPayload, Usage, UsageStatus, UsageWindow } from './types';

/** Above this, the item turns red; the default auto-switch threshold is 90. */
const PCT_DANGER = 90;
/** Above this, the item turns amber. */
const PCT_WARN = 75;

/** Short human labels for the non-ok usage states. */
const STATUS_LABELS: Record<UsageStatus, string> = {
  ok: 'ok',
  token_expired: 'token expired',
  api_key: 'API key (no quota)',
  keychain_unavailable: 'keychain unreadable',
  relogin_required: 'needs /login',
  foreign_credential: 'credential mismatch',
  no_credentials: 'no credentials',
  unavailable: 'usage unavailable',
};

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

/** The usage we can actually show: live if present, else the last known good. */
export function effectiveUsage(account: Account): { usage: Usage; stale: boolean } | undefined {
  if (account.usage) {
    return { usage: account.usage, stale: false };
  }
  if (account.lastGoodUsage) {
    return { usage: account.lastGoodUsage, stale: true };
  }
  return undefined;
}

/**
 * The window that decides this account's fate: the higher of 5h and 7d. This is
 * the same "binding window" idea the auto-switch engine uses, so the status bar
 * and the switching policy never disagree about how close you are.
 */
export function bindingWindow(
  usage: Usage
): { label: '5h' | '7d'; window: UsageWindow } | undefined {
  const five = usage.fiveHour;
  const seven = usage.sevenDay;
  if (five && seven) {
    return seven.pct > five.pct ? { label: '7d', window: seven } : { label: '5h', window: five };
  }
  if (five) {
    return { label: '5h', window: five };
  }
  if (seven) {
    return { label: '7d', window: seven };
  }
  return undefined;
}

function describeWindow(window: UsageWindow): string {
  const parts = [pct(window.pct)];
  if (window.countdown) {
    parts.push(`resets in ${window.countdown}`);
  }
  return parts.join(' · ');
}

function ageNote(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 90) {
    return '';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return ` _(${minutes}m ago)_`;
  }
  return ` _(${Math.round(minutes / 60)}h ago)_`;
}

function daysUntil(iso: string): number | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  return (then - Date.now()) / 86_400_000;
}

function accountTitle(account: Account): string {
  const marker = account.active ? '**▸**' : '　';
  const alias = account.alias ? ` \`${account.alias}\`` : '';
  const flags: string[] = [];
  if (account.disabled) {
    flags.push('disabled');
  }
  if (account.active) {
    flags.push('active');
  }
  const suffix = flags.length ? ` — _${flags.join(', ')}_` : '';
  return `${marker} **#${account.number}**${alias} ${account.email}${suffix}`;
}

function accountLines(account: Account): string[] {
  const lines = [accountTitle(account)];
  const effective = effectiveUsage(account);

  if (!effective) {
    lines.push(`　　${STATUS_LABELS[account.usageStatus] ?? account.usageStatus}`);
    if (account.usageError) {
      lines.push(`　　_last fetch failed: ${account.usageError}_`);
    }
    return lines;
  }

  const { usage, stale } = effective;
  const age = stale ? account.lastGoodAgeSeconds : account.usageAgeSeconds;

  if (usage.fiveHour) {
    lines.push(`　　5-hour: ${describeWindow(usage.fiveHour)}${ageNote(age)}`);
  }
  if (usage.sevenDay) {
    let line = `　　Weekly: ${describeWindow(usage.sevenDay)}`;
    if (usage.sevenDay.aheadOfPace) {
      line += ' · **ahead of pace**';
    }
    lines.push(line);
    if (usage.sevenDay.willLastToReset === false) {
      lines.push('　　⚠ projected to run out before the weekly reset');
    }
  }
  for (const scoped of usage.scoped ?? []) {
    lines.push(`　　${scoped.name ?? 'model'}: ${describeWindow(scoped)}`);
  }
  if (usage.spend) {
    lines.push(
      `　　Spend: ${pct(usage.spend.pct)} of ${usage.spend.limit} ${usage.spend.currency}`
    );
  }
  if (stale) {
    lines.push(`　　_showing last known numbers (${STATUS_LABELS[account.usageStatus]})_`);
  }

  if (account.loginExpiresAt) {
    const days = daysUntil(account.loginExpiresAt);
    if (days !== undefined && days < 7) {
      const when = days < 1 ? 'less than a day' : `${Math.floor(days)} days`;
      lines.push(`　　⚠ login expires in ${when} — run \`/login\` then \`cswap add --slot ${account.number}\``);
    }
  }
  return lines;
}

export interface StatusBarModel {
  payload?: ListPayload;
  error?: string;
  autoSwitchEnabled: boolean;
  threshold?: number;
  lastUpdated?: Date;
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeSwap.switchAccount';
    this.item.name = 'Claude Swap';
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  setBusy(message: string): void {
    this.item.text = `$(sync~spin) ${message}`;
    this.item.backgroundColor = undefined;
  }

  render(model: StatusBarModel): void {
    if (model.error) {
      this.item.text = '$(alert) Claude Swap';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.tooltip = this.buildTooltip(model);
      return;
    }

    const payload = model.payload;
    const active = payload?.accounts.find((a) => a.active);

    if (!payload || payload.accounts.length === 0) {
      this.item.text = '$(account) No accounts';
      this.item.backgroundColor = undefined;
      this.item.tooltip = this.buildTooltip(model);
      return;
    }

    if (!active) {
      // Managed accounts exist but the live login is not one of them.
      this.item.text = '$(alert) Unmanaged login';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.tooltip = this.buildTooltip(model);
      return;
    }

    const effective = effectiveUsage(active);
    const binding = effective ? bindingWindow(effective.usage) : undefined;

    if (!binding) {
      this.item.text = `$(account) #${active.number} · ${STATUS_LABELS[active.usageStatus]}`;
      this.item.backgroundColor =
        active.usageStatus === 'api_key'
          ? undefined
          : new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.tooltip = this.buildTooltip(model);
      return;
    }

    const value = binding.window.pct;
    const icon = model.autoSwitchEnabled ? '$(sync)' : '$(account)';
    let text = `${icon} #${active.number} · ${binding.label} ${pct(value)}`;
    if (value >= PCT_WARN && binding.window.countdown) {
      text += ` · ${binding.window.countdown}`;
    }
    if (effective?.stale) {
      text += ' $(history)';
    }

    this.item.text = text;
    this.item.backgroundColor =
      value >= PCT_DANGER
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : value >= PCT_WARN
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.tooltip = this.buildTooltip(model);
  }

  private buildTooltip(model: StatusBarModel): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown('**Claude Swap**\n\n');

    if (model.error) {
      md.appendMarkdown(`$(alert) ${model.error}\n\n`);
    } else if (!model.payload || model.payload.accounts.length === 0) {
      md.appendMarkdown(
        'No accounts are managed yet. Log into Claude Code, then run `cswap add` in a terminal.\n\n'
      );
    } else {
      for (const account of model.payload.accounts) {
        md.appendMarkdown(accountLines(account).join('\n\n') + '\n\n');
      }
      md.appendMarkdown('---\n\n');
    }

    const autoState = model.autoSwitchEnabled ? 'on' : 'off';
    const thresholdNote =
      model.threshold !== undefined ? ` at ${Math.round(model.threshold)}%` : '';
    md.appendMarkdown(`Background auto-switch: **${autoState}**${thresholdNote}\n\n`);
    if (model.lastUpdated) {
      md.appendMarkdown(`_Checked ${model.lastUpdated.toLocaleTimeString()}_\n\n`);
    }
    md.appendMarkdown(
      '[Switch account](command:claudeSwap.switchAccount) · ' +
        '[Most quota](command:claudeSwap.switchBest) · ' +
        '[Refresh](command:claudeSwap.refresh) · ' +
        `[Turn auto-switch ${model.autoSwitchEnabled ? 'off' : 'on'}](command:claudeSwap.toggleAutoSwitch) · ` +
        '[Logs](command:claudeSwap.showLogs)'
    );
    return md;
  }
}
