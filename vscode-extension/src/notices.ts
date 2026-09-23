/**
 * Proactive warnings drawn from data the CLI has but does not push at you.
 *
 * Both warnings here are deliberately once-per-day-per-account. A nag that fires
 * on every refresh gets dismissed reflexively and then ignored when it matters,
 * so the state of what has already been said is persisted in globalState rather
 * than kept in memory (where a window reload would reset it).
 */

import * as vscode from 'vscode';
import { earliestFiveHourReset, formatMinutes, hasHeadroom, hiddenModelConstraint } from './analysis';
import { effectiveUsage } from './statusBar';
import { log } from './log';
import { Account, ListPayload } from './types';

const DAY_MS = 86_400_000;

function daysUntil(iso: string): number | undefined {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  return (then - Date.now()) / DAY_MS;
}

export class Notices {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Whether every account was spent on the previous check. Held in memory rather
   * than persisted: it exists to detect the *transition* back to having quota, and
   * after a window reload the fresh reading is the truth, not a remembered state.
   */
  private allSpent = false;

  /** Identity, not slot number: slots get reused when accounts are re-added. */
  private key(kind: string, account: Account): string {
    return `notice:${kind}:${account.email}:${account.organizationUuid ?? ''}`;
  }

  private alreadySaidToday(key: string): boolean {
    const last = this.context.globalState.get<number>(key);
    return last !== undefined && Date.now() - last < DAY_MS;
  }

  private markSaid(key: string): void {
    void this.context.globalState.update(key, Date.now());
  }

  check(payload: ListPayload, threshold: number): void {
    const config = vscode.workspace.getConfiguration('claudeSwap');
    const expiryDays = config.get<number>('warnLoginExpiryDays') ?? 3;
    const showPace = config.get<boolean>('showPaceWarnings') ?? true;
    const resetAlarm = config.get<boolean>('notifyOnReset') ?? true;

    for (const account of payload.accounts) {
      if (expiryDays > 0) {
        this.checkLoginExpiry(account, expiryDays);
      }
      if (showPace) {
        this.checkPace(account);
      }
      this.checkHiddenModelLimit(account);
    }

    this.checkExhaustion(payload, threshold, resetAlarm);
  }

  /**
   * Notify on the *transition* out of "everything spent", rather than scheduling a
   * timer for the reset moment. A transition detector needs no clock arithmetic,
   * survives the machine sleeping through the reset, and cannot fire twice.
   */
  private checkExhaustion(payload: ListPayload, threshold: number, notify: boolean): void {
    const anyHeadroom = payload.accounts.some((a) => hasHeadroom(a, threshold));

    if (!anyHeadroom) {
      if (!this.allSpent) {
        this.allSpent = true;
        const reset = earliestFiveHourReset(payload.accounts);
        const wait =
          reset !== undefined && reset > Date.now()
            ? ` The soonest 5-hour window reopens in about ${formatMinutes((reset - Date.now()) / 60_000)}.`
            : '';
        log('notice: all accounts exhausted');
        if (notify) {
          void vscode.window.showWarningMessage(
            `Claude Swap: every account is at or past ${Math.round(threshold)}%.${wait}`
          );
        }
      }
      return;
    }

    if (this.allSpent) {
      this.allSpent = false;
      log('notice: quota available again');
      if (notify) {
        const freed = payload.accounts.find((a) => hasHeadroom(a, threshold));
        void vscode.window
          .showInformationMessage(
            `Claude Swap: quota is available again — account #${freed?.number} has room.`,
            'Switch to it',
            'OK'
          )
          .then((choice) => {
            if (choice === 'Switch to it' && freed) {
              void vscode.commands.executeCommand(
                'claudeSwap.switchToAccount',
                String(freed.number)
              );
            }
          });
      }
    }
  }

  /**
   * A per-model weekly limit can be the thing that actually stops you while the
   * account-level percentage still looks fine. Auto-switch ignores per-model
   * windows unless `autoswitch.model` names one, so this both warns and says how
   * to make switching account for it.
   */
  private checkHiddenModelLimit(account: Account): void {
    const effective = effectiveUsage(account);
    if (!effective) {
      return;
    }
    const hidden = hiddenModelConstraint(effective.usage);
    if (!hidden || hidden.pct < 70) {
      return;
    }
    const key = this.key(`model:${hidden.name ?? '?'}`, account);
    if (this.alreadySaidToday(key)) {
      return;
    }
    log(`notice: account ${account.number} model window ${hidden.name} at ${hidden.pct}%`);
    this.markSaid(key);

    const name = hidden.name ?? 'a model';
    void vscode.window
      .showWarningMessage(
        `Claude Swap: account #${account.number} has used ${Math.round(hidden.pct)}% of its ` +
          `weekly ${name} limit — further along than its overall limits, so this is what will ` +
          'stop you first. Auto-switch ignores per-model limits unless you tell it not to.',
        'How?',
        'Dismiss'
      )
      .then((choice) => {
        if (choice === 'How?') {
          void vscode.window.showInformationMessage(
            `Run this in a terminal to make auto-switch account for the ${name} limit too:\n\n` +
              `cswap config set autoswitch.model ${name}`,
            { modal: true }
          );
        }
      });
  }

  /**
   * A stored login whose refresh token is about to expire will simply stop
   * working, and the fix needs a browser (`/login`) — so it must be known about
   * before the moment you need that account, not at the moment you switch to it.
   */
  private checkLoginExpiry(account: Account, withinDays: number): void {
    if (!account.loginExpiresAt) {
      return;
    }
    const days = daysUntil(account.loginExpiresAt);
    if (days === undefined || days > withinDays) {
      return;
    }
    const key = this.key('login-expiry', account);
    if (this.alreadySaidToday(key)) {
      return;
    }

    const when =
      days < 0 ? 'has expired' : days < 1 ? 'expires in less than a day' : `expires in ${Math.floor(days)} days`;
    log(`notice: account ${account.number} login ${when}`);
    this.markSaid(key);

    void vscode.window
      .showWarningMessage(
        `Claude Swap: account #${account.number} (${account.email}) ${when}. ` +
          'Log into Claude Code with it, then re-add it to refresh the stored token.',
        'How do I fix it?',
        'Dismiss'
      )
      .then((choice) => {
        if (choice === 'How do I fix it?') {
          void vscode.window.showInformationMessage(
            `In Claude Code run /login and sign in as ${account.email}, then in a terminal run: ` +
              `cswap add --slot ${account.number}`,
            { modal: true }
          );
        }
      });
  }

  /**
   * The weekly projection is a linear extrapolation, which is why the CLI keeps
   * it out of its human output. As a once-a-day heads-up it is still worth
   * having: it is the difference between finding out now and finding out on
   * Friday afternoon.
   */
  private checkPace(account: Account): void {
    const weekly = account.usage?.sevenDay;
    if (!weekly || weekly.willLastToReset !== false || !weekly.aheadOfPace) {
      return;
    }
    const key = this.key('pace', account);
    if (this.alreadySaidToday(key)) {
      return;
    }
    log(`notice: account ${account.number} projected to exhaust weekly quota early`);
    this.markSaid(key);

    const expected =
      weekly.expectedPct !== undefined ? ` (even pace would be ~${Math.round(weekly.expectedPct)}%)` : '';
    void vscode.window.showInformationMessage(
      `Claude Swap: account #${account.number} has used ${Math.round(weekly.pct)}% of its weekly quota` +
        `${expected} and is projected to run out before it resets` +
        (weekly.countdown ? ` in ${weekly.countdown}` : '') +
        '. Rough projection, not a certainty.'
    );
  }
}
