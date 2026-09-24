/**
 * Pure analysis of usage data. No `vscode` import, no I/O — everything here is a
 * function of its arguments, so it can be tested directly with `node --test`.
 *
 * The burn-rate code is the reason this module exists separately. A usage window
 * *resets*, which means the naive "percentage now minus percentage then" produces
 * a large negative rate exactly when a window rolls over. Every calculation below
 * is therefore scoped to a single window *generation*, identified by its
 * `resetsAt` timestamp.
 */

import { Account, Usage, UsageWindow } from './types';

/** A recorded observation of one account, for rate-of-change analysis. */
export interface UsageSample {
  /** Epoch milliseconds. */
  ts: number;
  fiveHourPct?: number;
  /** Window generation identity. A change here means the window rolled over. */
  fiveHourResetsAt?: string;
  sevenDayPct?: number;
  sevenDayResetsAt?: string;
}

/** Samples closer together than this add noise without adding information. */
export const MIN_SAMPLE_GAP_MS = 4 * 60 * 1000;
/** Keep history bounded; ~200 samples at 5-minute spacing is about 16 hours. */
export const MAX_SAMPLES = 200;
/** Below this many samples in the current window, no rate is reported. */
const MIN_SAMPLES_FOR_RATE = 3;
/** Below this span, a rate is dominated by rounding in the 1%-resolution data. */
const MIN_SPAN_MS = 12 * 60 * 1000;
/** Rates below this are indistinguishable from noise; report no projection. */
const MIN_MEANINGFUL_PCT_PER_HOUR = 0.5;

// ---------------------------------------------------------------------------
// Reading what usage is available
// ---------------------------------------------------------------------------

/** Live usage if present, else the last known good measurement. */
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
 * The window that decides this account's fate: the higher of 5h and 7d.
 *
 * Deliberately excludes per-model (`scoped`) windows even though one can be
 * higher, because claude-swap's auto-switch engine only considers 5h/7d unless
 * `autoswitch.model` is configured. If this returned a model window, the status
 * bar would show a number the switching policy does not act on. Model windows are
 * surfaced separately by `worstScopedWindow`.
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

/** The most-consumed per-model weekly window, if any are reported. */
export function worstScopedWindow(usage: Usage): UsageWindow | undefined {
  const scoped = usage.scoped;
  if (!scoped || scoped.length === 0) {
    return undefined;
  }
  return scoped.reduce((worst, w) => (w.pct > worst.pct ? w : worst));
}

/**
 * A per-model window that is meaningfully more consumed than the account-level
 * windows — the blind spot this warns about. You can be blocked on the Fable
 * weekly limit while the account-level number still reads 30%.
 *
 * `marginPct` avoids firing when the model window merely rounds higher than the
 * account window it is a subset of.
 */
export function hiddenModelConstraint(
  usage: Usage,
  marginPct = 15
): UsageWindow | undefined {
  const scoped = worstScopedWindow(usage);
  if (!scoped) {
    return undefined;
  }
  const binding = bindingWindow(usage);
  const bindingPct = binding ? binding.window.pct : 0;
  return scoped.pct >= bindingPct + marginPct ? scoped : undefined;
}

// ---------------------------------------------------------------------------
// Exhaustion
// ---------------------------------------------------------------------------

/** Whether this account can still be switched onto and used. */
export function hasHeadroom(account: Account, thresholdPct: number): boolean {
  if (account.disabled) {
    return false;
  }
  // API-key accounts have no subscription quota, so they are never "exhausted".
  if (account.usageStatus === 'api_key') {
    return true;
  }
  const effective = effectiveUsage(account);
  if (!effective) {
    return false;
  }
  const binding = bindingWindow(effective.usage);
  return binding !== undefined && binding.window.pct < thresholdPct;
}

/**
 * The soonest moment any account regains quota, as an epoch. Used to count down
 * to "you can work again" while everything is exhausted.
 *
 * Only 5-hour windows are considered: a weekly reset is too far away to be a
 * useful countdown, and in practice the 5-hour window is what frees up first.
 */
export function earliestFiveHourReset(accounts: Account[]): number | undefined {
  let soonest: number | undefined;
  for (const account of accounts) {
    if (account.disabled) {
      continue;
    }
    const effective = effectiveUsage(account);
    const resetsAt = effective?.usage.fiveHour?.resetsAt;
    if (!resetsAt) {
      continue;
    }
    const at = Date.parse(resetsAt);
    if (Number.isNaN(at)) {
      continue;
    }
    if (soonest === undefined || at < soonest) {
      soonest = at;
    }
  }
  return soonest;
}

// ---------------------------------------------------------------------------
// Burn rate
// ---------------------------------------------------------------------------

export interface BurnRate {
  /** Percentage points of the window consumed per hour. */
  pctPerHour: number;
  /** Minutes until the window reaches 100%, or null when not projectable. */
  minutesToFull: number | null;
  /** How many samples the estimate is based on. */
  sampleCount: number;
  /** The time span those samples cover, in minutes. */
  spanMinutes: number;
}

type WindowKey = 'fiveHour' | 'sevenDay';

function pctOf(sample: UsageSample, key: WindowKey): number | undefined {
  return key === 'fiveHour' ? sample.fiveHourPct : sample.sevenDayPct;
}

function generationOf(sample: UsageSample, key: WindowKey): string | undefined {
  return key === 'fiveHour' ? sample.fiveHourResetsAt : sample.sevenDayResetsAt;
}

/**
 * Least-squares slope of pct against time, in percentage points per hour.
 * Regression rather than (last - first) / elapsed because the API reports whole
 * percentages: with 1% resolution, two endpoints can differ by a single rounding
 * step, and a fit across all samples is far less jumpy.
 */
function slopePctPerHour(points: Array<{ hours: number; pct: number }>): number {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.hours, 0) / n;
  const meanY = points.reduce((s, p) => s + p.pct, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.hours - meanX) * (p.pct - meanY);
    den += (p.hours - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Estimate how fast a window is being consumed.
 *
 * Only samples belonging to the *current* window generation are used. This is
 * what keeps a window rollover — where the percentage legitimately drops to near
 * zero — from being read as a large negative burn rate.
 *
 * Returns undefined when there is not enough evidence, which is the common case
 * early on and must render as "unknown" rather than as zero.
 */
export function computeBurnRate(
  samples: UsageSample[],
  key: WindowKey = 'fiveHour'
): BurnRate | undefined {
  if (samples.length < MIN_SAMPLES_FOR_RATE) {
    return undefined;
  }
  const ordered = [...samples].sort((a, b) => a.ts - b.ts);
  const latest = ordered[ordered.length - 1];
  const generation = generationOf(latest, key);
  if (generation === undefined) {
    return undefined;
  }

  const current = ordered.filter(
    (s) => generationOf(s, key) === generation && pctOf(s, key) !== undefined
  );
  if (current.length < MIN_SAMPLES_FOR_RATE) {
    return undefined;
  }

  const spanMs = current[current.length - 1].ts - current[0].ts;
  if (spanMs < MIN_SPAN_MS) {
    return undefined;
  }

  const t0 = current[0].ts;
  const points = current.map((s) => ({
    hours: (s.ts - t0) / 3_600_000,
    pct: pctOf(s, key) as number,
  }));

  const pctPerHour = slopePctPerHour(points);
  const latestPct = pctOf(latest, key) as number;

  let minutesToFull: number | null = null;
  if (pctPerHour >= MIN_MEANINGFUL_PCT_PER_HOUR && latestPct < 100) {
    minutesToFull = ((100 - latestPct) / pctPerHour) * 60;
  }

  return {
    pctPerHour,
    minutesToFull,
    sampleCount: current.length,
    spanMinutes: spanMs / 60_000,
  };
}

/**
 * Append a sample, dropping ones too close together and capping total length.
 * Returns a new array; the input is not modified.
 */
export function recordSample(history: UsageSample[], sample: UsageSample): UsageSample[] {
  const ordered = [...history].sort((a, b) => a.ts - b.ts);
  const last = ordered[ordered.length - 1];
  if (last && sample.ts - last.ts < MIN_SAMPLE_GAP_MS) {
    return ordered;
  }
  ordered.push(sample);
  return ordered.length > MAX_SAMPLES ? ordered.slice(ordered.length - MAX_SAMPLES) : ordered;
}

/** Stable identity for an account across slot renumbering. */
export function accountKey(account: Account): string {
  return `${account.email}|${account.organizationUuid ?? ''}`;
}

// ---------------------------------------------------------------------------
// Leader election between VS Code windows
// ---------------------------------------------------------------------------

/**
 * A claim on being the one window that runs the background auto-switch timer.
 *
 * Every open VS Code window loads its own copy of this extension, so without a
 * leader N windows spawn N `cswap auto --once` processes on the same schedule.
 * claude-swap serialises them correctly — its under-lock cooldown re-check makes
 * the loser back off, and FileLock was measured to exclude across processes on
 * Windows (5 processes, strictly serialised, 2026-09-24) — but two cases
 * deliberately bypass that cooldown: `at-limit` and `failover`, because an account
 * already at its limit must move regardless of how recently anything moved. Two
 * windows ranking candidates differently could then each switch once, which is not
 * a ping-pong (the no-return filter blocks the return leg) but is a wasted hop and
 * an extra prompt-cache rebuild.
 *
 * Electing a leader removes the whole class rather than re-implementing the
 * cooldown here, which would duplicate policy that must stay in one place.
 */
export interface Lease {
  pid: number;
  ts: number;
}

/** A lease older than this is treated as abandoned (window closed, crash, sleep). */
export const LEASE_STALE_MS = 4 * 60 * 1000;

export interface LeaseState {
  /** Whether the lease file exists at all. */
  exists: boolean;
  /** Age from the file's mtime, in ms. Undefined when it does not exist. */
  ageMs?: number;
  /** Holder pid from the file's contents; undefined when unreadable or empty. */
  holderPid?: number;
}

/**
 * What this process should do about the timer.
 *
 * - `claim` — nothing holds it; create the lease.
 * - `refresh` — already ours; update the timestamp and keep ticking.
 * - `take-over` — the holder abandoned it; remove and re-create.
 * - `stand-down` — another live window has it.
 *
 * **Staleness must come from the file's mtime, never from its contents.** Measured
 * failure (2026-09-24, 8 racing processes): an earlier version decided staleness
 * from the JSON body and treated an unreadable body as abandoned. Between one
 * process creating the file and writing into it, the others read it as EMPTY,
 * concluded it was abandoned, DELETED it and re-created their own — electing 3
 * leaders out of 8. The mtime is set atomically by the filesystem at creation, so a
 * just-created empty file reads as fresh and is correctly respected.
 *
 * A negative age (a file stamped in the future, from clock skew or a restored
 * snapshot) counts as fresh, not stale: handing the timer to two windows is worse
 * than delaying a tick.
 */
export function leaseVerdict(
  state: LeaseState,
  myPid: number,
  staleAfterMs = LEASE_STALE_MS
): 'claim' | 'refresh' | 'take-over' | 'stand-down' {
  if (!state.exists) {
    return 'claim';
  }
  if (state.holderPid === myPid) {
    return 'refresh';
  }
  const age = state.ageMs;
  if (typeof age !== 'number' || Number.isNaN(age)) {
    return 'stand-down'; // cannot establish an age: assume someone holds it
  }
  return age > staleAfterMs ? 'take-over' : 'stand-down';
}

/** "2h 40m", "45m", "less than a minute" — for durations we compute ourselves. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) {
    return 'less than a minute';
  }
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
