/** Rendering of the status bar item and its hover tooltip. */

import * as vscode from 'vscode';
import {
  BurnRate,
  bindingWindow,
  earliestFiveHourReset,
  effectiveUsage,
  formatMinutes,
  hasHeadroom,
  hiddenModelConstraint,
  worstScopedWindow,
} from './analysis';
import { Account, ListPayload, UsageStatus, UsageWindow } from './types';

/** Above this, the item turns red; the default auto-switch threshold is 90. */
const PCT_DANGER = 90;
/** Above this, the item turns amber. */
const PCT_WARN = 75;
/** Beyond this many accounts, the status bar shows only the active one. */
const MAX_ACCOUNTS_INLINE = 4;

/** Short human labels for the non-ok usage states. */
export const STATUS_LABELS: Record<UsageStatus, string> = {
  ok: 'ok',
  token_expired: 'token expired',
  api_key: 'API key (no quota)',
  keychain_unavailable: 'keychain unreadable',
  relogin_required: 'needs /login',
  foreign_credential: 'credential mismatch',
  no_credentials: 'no credentials',
  unavailable: 'usage unavailable',
};

export function pct(value: number): string {
  return `${Math.round(value)}%`;
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

export function daysUntil(iso: string): number | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  return (then - Date.now()) / 86_400_000;
}

/** "burning ~9%/h · about 2h 40m left" — or undefined when not yet knowable. */
export function describeBurnRate(rate: BurnRate | undefined): string | undefined {
  if (!rate) {
    return undefined;
  }
  if (rate.pctPerHour < 0.5) {
    return 'not being consumed right now';
  }
  const head = `burning ~${rate.pctPerHour.toFixed(1)}%/h`;
  if (rate.minutesToFull === null) {
    return head;
  }
  return `${head} · about ${formatMinutes(rate.minutesToFull)} of headroom`;
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

function accountLines(account: Account, rate: BurnRate | undefined): string[] {
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
    const burn = describeBurnRate(rate);
    if (burn) {
      lines.push(`　　　${burn}`);
    }
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

  const hidden = hiddenModelConstraint(usage);
  for (const scoped of usage.scoped ?? []) {
    const flag = scoped === hidden ? ' ⚠ **this is your real limit**' : '';
    lines.push(`　　${scoped.name ?? 'model'}: ${describeWindow(scoped)}${flag}`);
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
      lines.push(
        `　　⚠ login expires in ${when} — run \`/login\` then \`cswap add --slot ${account.number}\``
      );
    }
  }
  return lines;
}

/** One compact `#2 19%` chunk, used when showing every account inline. */
function inlineChunk(account: Account): string {
  const effective = effectiveUsage(account);
  const binding = effective ? bindingWindow(effective.usage) : undefined;
  const value = binding ? pct(binding.window.pct) : '—';
  return `#${account.number} ${value}`;
}

export interface StatusBarModel {
  payload?: ListPayload;
  error?: string;
  autoSwitchEnabled: boolean;
  threshold?: number;
  lastUpdated?: Date;
  /** Burn rate per account number, for the tooltip. */
  rates?: Map<number, BurnRate | undefined>;
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

  private showAllAccounts(): boolean {
    return (
      vscode.workspace.getConfiguration('claudeSwap').get<boolean>('statusBar.showAllAccounts') ??
      true
    );
  }

  render(model: StatusBarModel): void {
    this.item.tooltip = this.buildTooltip(model);

    if (model.error) {
      this.item.text = '$(alert) Claude Swap';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      return;
    }

    const payload = model.payload;
    if (!payload || payload.accounts.length === 0) {
      this.item.text = '$(account) No accounts';
      this.item.backgroundColor = undefined;
      return;
    }

    const active = payload.accounts.find((a) => a.active);
    if (!active) {
      this.item.text = '$(alert) Unmanaged login';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    const threshold = model.threshold ?? PCT_DANGER;

    // Everything exhausted: the only useful number is when you can work again.
    const anyHeadroom = payload.accounts.some((a) => hasHeadroom(a, threshold));
    if (!anyHeadroom) {
      const reset = earliestFiveHourReset(payload.accounts);
      const wait =
        reset !== undefined && reset > Date.now()
          ? ` · back in ${formatMinutes((reset - Date.now()) / 60_000)}`
          : '';
      this.item.text = `$(stop-circle) All accounts spent${wait}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
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
      return;
    }

    const value = binding.window.pct;
    const icon = model.autoSwitchEnabled ? '$(sync)' : '$(account)';

    let body: string;
    if (this.showAllAccounts() && payload.accounts.length <= MAX_ACCOUNTS_INLINE) {
      // Active account first, then the rest in slot order — a stable layout, so
      // the number in a given position does not move around between refreshes.
      const others = payload.accounts.filter((a) => !a.active);
      body = [
        `${inlineChunk(active)}`,
        ...others.map((a) => inlineChunk(a)),
      ].join(' | ');
    } else {
      body = `#${active.number} · ${binding.label} ${pct(value)}`;
      if (value >= PCT_WARN && binding.window.countdown) {
        body += ` · ${binding.window.countdown}`;
      }
    }

    // A per-model window far above the account windows is the real constraint,
    // and the account-level percentage hides it completely.
    const hidden = effective ? hiddenModelConstraint(effective.usage) : undefined;
    const hiddenFlag = hidden ? ` $(warning)${hidden.name ?? 'model'} ${pct(hidden.pct)}` : '';

    this.item.text = `${icon} ${body}${hiddenFlag}${effective?.stale ? ' $(history)' : ''}`;

    const worstShown = hidden ? Math.max(value, hidden.pct) : value;
    this.item.backgroundColor =
      worstShown >= PCT_DANGER
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : worstShown >= PCT_WARN
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
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
        const rate = model.rates?.get(account.number);
        md.appendMarkdown(accountLines(account, rate).join('\n\n') + '\n\n');
      }

      const modelHit = model.payload.accounts
        .map((a) => {
          const e = effectiveUsage(a);
          return e ? hiddenModelConstraint(e.usage) : undefined;
        })
        .find((w) => w !== undefined);
      if (modelHit) {
        md.appendMarkdown(
          `⚠ A per-model limit (**${modelHit.name}**) is further along than your account ` +
            'limits. Auto-switch ignores per-model windows unless you tell it not to:\n\n' +
            `\`cswap config set autoswitch.model ${modelHit.name}\`\n\n`
        );
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

// Re-exported so other modules have one import site for display helpers.
export { bindingWindow, effectiveUsage, worstScopedWindow };
