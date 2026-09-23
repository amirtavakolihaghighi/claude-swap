/**
 * Persisted usage history, the input to burn-rate analysis.
 *
 * Kept in `globalState` rather than a file: it is small (bounded at 200 samples
 * per account), it is per-machine by nature, and VS Code already handles its
 * storage location and cleanup. Keyed by account identity rather than slot
 * number, because slot numbers are reused when an account is removed and re-added
 * — a reused slot inheriting the previous account's burn rate would be wrong in a
 * way nobody would notice.
 */

import * as vscode from 'vscode';
import {
  BurnRate,
  UsageSample,
  accountKey,
  computeBurnRate,
  effectiveUsage,
  recordSample,
} from './analysis';
import { Account } from './types';

const KEY_PREFIX = 'usageHistory:';

export class UsageHistory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private read(key: string): UsageSample[] {
    return this.context.globalState.get<UsageSample[]>(KEY_PREFIX + key) ?? [];
  }

  private write(key: string, samples: UsageSample[]): void {
    void this.context.globalState.update(KEY_PREFIX + key, samples);
  }

  /**
   * Record the current reading for every account. Samples arriving sooner than
   * the minimum gap are dropped by `recordSample`, so calling this on every
   * refresh is safe and keeps the spacing even.
   */
  observe(accounts: Account[], now = Date.now()): void {
    for (const account of accounts) {
      const effective = effectiveUsage(account);
      // A stale reading is a repeat of a measurement already recorded at its own
      // timestamp; recording it again at `now` would flatten the apparent rate.
      if (!effective || effective.stale) {
        continue;
      }
      const { usage } = effective;
      const sample: UsageSample = {
        ts: now,
        fiveHourPct: usage.fiveHour?.pct,
        fiveHourResetsAt: usage.fiveHour?.resetsAt,
        sevenDayPct: usage.sevenDay?.pct,
        sevenDayResetsAt: usage.sevenDay?.resetsAt,
      };
      const key = accountKey(account);
      this.write(key, recordSample(this.read(key), sample));
    }
  }

  /** The 5-hour burn rate for one account, or undefined without enough history. */
  burnRate(account: Account): BurnRate | undefined {
    return computeBurnRate(this.read(accountKey(account)), 'fiveHour');
  }

  /** How many samples are held for an account — shown when a rate is not yet ready. */
  sampleCount(account: Account): number {
    return this.read(accountKey(account)).length;
  }

  /** Forget everything. Exposed for the "reset history" command. */
  clear(accounts: Account[]): void {
    for (const account of accounts) {
      void this.context.globalState.update(KEY_PREFIX + accountKey(account), undefined);
    }
  }
}
