/**
 * Proactive warnings drawn from data the CLI has but does not push at you.
 *
 * Both warnings here are deliberately once-per-day-per-account. A nag that fires
 * on every refresh gets dismissed reflexively and then ignored when it matters,
 * so the state of what has already been said is persisted in globalState rather
 * than kept in memory (where a window reload would reset it).
 */

import * as vscode from 'vscode';
import {
  earliestFiveHourReset,
  formatMinutes,
  freshSignIns,
  hasHeadroom,
  hiddenModelConstraint,
  SaveLoginPlan,
  saveLoginPlan,
} from './analysis';
import { effectiveUsage } from './statusBar';
import { log } from './log';
import { Account, ListPayload, StatusPayload } from './types';

const DAY_MS = 86_400_000;

/** globalState key for the last loginExpiresAt seen per account (see freshSignIns). */
const SEEN_LOGIN_EXPIRY_KEY = 'signIns:loginExpiresAt';

/** An unknown signed-in account can stay unknown for hours; ask `status` this rarely. */
const UNKNOWN_LOGIN_CHECK_MS = 5 * 60_000;

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

  private lastUnknownLoginCheck = 0;

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
   * Offer *Save Current Login* when Claude Code holds a login claude-swap may not
   * have saved: a fresh sign-in to an account it knows, or one it does not know.
   *
   * cswap usually saves a fresh sign-in by itself, but only once Anthropic has
   * confirmed whose it is, and it leaves everything untouched when that check
   * fails (`_self_switch_action` in switcher.py). On a flaky connection that is
   * often, and the cost shows up later: the next switch back to that account hands
   * Claude a login that no longer works, and it asks you to sign in again.
   */
  async checkSignIns(
    payload: ListPayload,
    readStatus: () => Promise<StatusPayload>
  ): Promise<void> {
    const { signedIn, seen } = freshSignIns(
      this.context.globalState.get<Record<string, string>>(SEEN_LOGIN_EXPIRY_KEY) ?? {},
      payload.accounts
    );
    await this.context.globalState.update(SEEN_LOGIN_EXPIRY_KEY, seen);
    for (const account of signedIn) {
      log(`notice: fresh sign-in to account ${account.number}`);
      this.offerSave(
        `Claude Swap: you signed in to account #${account.number} (${account.email}) again. ` +
          `Save the new login, so switching back to #${account.number} keeps working?`,
        'Save login'
      );
    }

    // No managed account is active: Claude is signed out, or signed in to an
    // account claude-swap does not know. Only `status` can tell which.
    if (payload.accounts.some((a) => a.active)) {
      return;
    }
    if (Date.now() - this.lastUnknownLoginCheck < UNKNOWN_LOGIN_CHECK_MS) {
      return;
    }
    this.lastUnknownLoginCheck = Date.now();
    let plan: SaveLoginPlan;
    try {
      plan = saveLoginPlan((await readStatus()).active);
    } catch {
      return; // the refresh that called us reports cswap failures already
    }
    if (plan.kind !== 'add') {
      return;
    }
    const key = `notice:unknown-login:${plan.email}`;
    if (this.alreadySaidToday(key)) {
      return;
    }
    log(`notice: Claude is signed in to an account claude-swap does not know`);
    this.markSaid(key);
    this.offerSave(
      `Claude Swap: Claude Code is signed in as ${plan.email}, which Claude Swap doesn't ` +
        'know yet. Add it, so you can switch to it and see its usage?',
      'Add account'
    );
  }

  private offerSave(message: string, action: string): void {
    void vscode.window.showInformationMessage(message, action, 'Not now').then((choice) => {
      if (choice === action) {
        // The click already answered "add this account?", so don't ask it again.
        void vscode.commands.executeCommand('claudeSwap.saveLogin', { confirmed: true });
      }
    });
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

    // No terminal step any more: once the user has signed in again, checkSignIns
    // notices the new login and offers to save it.
    const signIn = `sign in as ${account.email}`;
    const next =
      days >= 0
        ? `When it does, Claude will ask you to sign in${account.active ? '' : ` the next time you use #${account.number}`}: ${signIn}.`
        : account.active
          ? `Claude will ask you to sign in: ${signIn}.`
          : `To use it again, type /login in a Claude tab and ${signIn}.`;
    void vscode.window.showWarningMessage(
      `Claude Swap: account #${account.number}'s login ${when}. ${next} ` +
        'Claude Swap will then offer to save the new login.'
    );
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
