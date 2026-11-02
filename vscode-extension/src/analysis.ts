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

import { Account, StatusPayload, Usage, UsageStatus, UsageWindow } from './types';

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

// ---------------------------------------------------------------------------
// What to say after a switch
// ---------------------------------------------------------------------------

/**
 * The sentence shown after a switch, and whether a "Reload window" button would
 * change anything for the user.
 *
 * On Windows and Linux the active login is a file, and Claude Code drops its cached
 * token as soon as that file changes, so every open Claude tab is on the new account
 * from its next message — claude-swap's own follow-up for this case reads "no restart
 * needed" (`_print_switch_followup` in switcher.py). The popup used to offer "Reload
 * window" there anyway, and that left a user asking whether the switch was active at
 * all (2026-11-02). So the button is offered only where it does something.
 *
 * On macOS the login lives in the Keychain, which Claude Code caches for about 30
 * seconds, so a reload is the one way to apply it at once. cswap falls back to the
 * file when the Keychain is unusable, but the switch payload does not say which
 * happened, and an unneeded offer there costs less than a missing one.
 */
export function afterSwitchNotice(platform: string): { note: string; offerReload: boolean } {
  if (platform === 'darwin') {
    return {
      note: 'Open Claude tabs pick it up within about 30 seconds — reload the window to use it right away.',
      offerReload: true,
    };
  }
  return {
    note: "It's active now — your next message in any Claude tab uses it.",
    offerReload: false,
  };
}

// ---------------------------------------------------------------------------
// Explaining a manual refresh
// ---------------------------------------------------------------------------

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

/** What each state means and what to do about it, for tooltips. */
export const STATUS_HELP: Record<UsageStatus, string> = {
  ok: 'Usage was read normally.',
  token_expired:
    "Its short-term key has expired. That is normal: Claude renews it on the next message sent with this account. Nothing to do.",
  api_key: 'This account uses an API key, which has no subscription limits to show.',
  keychain_unavailable: 'The macOS Keychain could not be read right now (locked, or no desktop session). It is tried again later.',
  relogin_required:
    'Its saved login no longer works. Sign in to Claude as this account (type /login in a Claude tab), then use Save Current Login.',
  foreign_credential:
    'The login Claude holds belongs to a different account than this one. Sign in as the right account, then use Save Current Login.',
  no_credentials: 'Claude Swap has no saved login for this account. Sign in to Claude as it, then use Save Current Login.',
  unavailable: "Usage could not be checked just now. Claude Swap keeps the last good numbers and tries again on its own schedule.",
};

/**
 * A failed usage check, in plain words. `kind` is claude-swap's stable token from
 * `_classify_usage_error` in oauth.py: `http-<code>`, `timeout`, `network`,
 * `bad-response`, or an exception class name as a fallback.
 */
export function describeFetchError(kind: string): string {
  switch (kind) {
    case 'network':
      return 'a network problem reaching Anthropic';
    case 'timeout':
      return 'Anthropic took too long to answer';
    case 'bad-response':
      return "Anthropic's answer could not be read";
  }
  const http = /^http-(\d{3})$/.exec(kind);
  if (!http) {
    return `the check failed (${kind})`;
  }
  const code = Number(http[1]);
  if (code === 429) {
    return 'too many usage checks, so Anthropic asked to wait';
  }
  if (code === 401) {
    return "Anthropic didn't accept the login";
  }
  if (code === 403) {
    return 'Anthropic refused the request';
  }
  if (code >= 500) {
    return `a problem on Anthropic's side (error ${code})`;
  }
  return `Anthropic answered with error ${code}`;
}

/** Below this age a reading is reported as "just now". */
const JUST_NOW_S = 60;

// Not "every few minutes": after an http-429 claude-swap backs off much further, and
// the first real run of this message showed the active account 22 minutes old.
const CADENCE_NOTE =
  "Refresh shows the latest check; it can't force a new one. Anthropic allows only " +
  'about 30 usage checks an hour per account, so Claude Swap spaces them out, and ' +
  'waits longer after Anthropic says it has had too many.';

/**
 * What a manual refresh found, one sentence per account (active first), for the
 * notification shown after the click.
 *
 * A click cannot force new numbers: claude-swap serves its stored reading until the
 * account's next scheduled check, because the usage endpoint allows ~28-30 requests
 * an hour per account (see poll_policy.py). So a click usually changes nothing on
 * screen, which a user reported as "Refresh does nothing" (2026-11-02). Saying how
 * old each reading is, and why a failed check failed, turns that silence into an
 * answer. The cadence is deliberately not restated in numbers: it is claude-swap's
 * policy and changes there.
 */
export function describeRefresh(accounts: Account[], nowMs: number): string {
  if (accounts.length === 0) {
    return 'No accounts are set up yet.';
  }
  const ordered = [...accounts].sort(
    (a, b) => Number(b.active) - Number(a.active) || a.number - b.number
  );
  const sentences: string[] = [];
  let showsAgingReading = false;

  for (const account of ordered) {
    const label = `#${account.number}${account.active ? ' (active)' : ''}`;

    if (account.usage) {
      const age = account.usageAgeSeconds;
      if (age === undefined || age < JUST_NOW_S) {
        sentences.push(`${label} was checked just now.`);
      } else {
        showsAgingReading = true;
        sentences.push(`${label} was checked ${formatMinutes(age / 60)} ago.`);
      }
      continue;
    }

    let sentence = account.usageError
      ? `${label} has no new numbers: ${describeFetchError(account.usageError)}`
      : `${label}: ${STATUS_LABELS[account.usageStatus] ?? account.usageStatus}`;
    if (account.lastGoodAgeSeconds !== undefined) {
      sentence += ` — showing numbers from ${formatMinutes(account.lastGoodAgeSeconds / 60)} ago`;
    }
    const retryAt = account.usageRetryAt ? Date.parse(account.usageRetryAt) : Number.NaN;
    if (Number.isFinite(retryAt)) {
      const minutes = (retryAt - nowMs) / 60_000;
      sentence += minutes < 1 ? ', next try any moment' : `, next try in about ${formatMinutes(minutes)}`;
    }
    sentences.push(`${sentence}.`);
  }

  if (showsAgingReading) {
    sentences.push(CADENCE_NOTE);
  }
  return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// Saving Claude Code's current login
// ---------------------------------------------------------------------------

/** What *Save Current Login* would do, read from `cswap status --json`. */
export type SaveLoginPlan =
  | { kind: 'not-signed-in' }
  | { kind: 'update'; number: number; email: string }
  | { kind: 'add'; email: string };

/**
 * `cswap add` with no slot updates the account Claude Code is signed in as, or adds
 * it when claude-swap does not know it (`add_account` in switcher.py). `status`
 * tells the two apart: `active` is null when nobody is signed in, and carries
 * `managed: false` and no number for an account claude-swap does not manage.
 */
export function saveLoginPlan(active: StatusPayload['active']): SaveLoginPlan {
  if (!active || !active.email) {
    return { kind: 'not-signed-in' };
  }
  if (active.managed === false || typeof active.number !== 'number') {
    return { kind: 'add', email: active.email };
  }
  return { kind: 'update', number: active.number, email: active.email };
}

/** How much later a login's expiry must move to count as a new sign-in. */
const SIGN_IN_JUMP_MS = 86_400_000;

/**
 * Accounts signed in to afresh since the expiry dates in `seen`, and the dates to
 * remember for next time.
 *
 * A login's `loginExpiresAt` is fixed for its whole life — measured 2026-11-02:
 * account #2, signed in on Oct 27 at 12:34Z, still read 2026-11-26T12:34:07Z
 * after five token rotations — so the date moving later means a new sign-in. Only
 * the active row is judged, because only its date comes from Claude Code's live
 * login; every other row reads claude-swap's saved copy (`_accounts_info` in
 * switcher.py), which moving means the new login was already saved.
 */
export function freshSignIns(
  seen: Record<string, string>,
  accounts: Account[]
): { signedIn: Account[]; seen: Record<string, string> } {
  const next = { ...seen };
  const signedIn: Account[] = [];
  for (const account of accounts) {
    if (!account.loginExpiresAt) {
      continue;
    }
    const key = accountKey(account);
    const before = Date.parse(seen[key] ?? '');
    const now = Date.parse(account.loginExpiresAt);
    if (account.active && Number.isFinite(before) && now - before > SIGN_IN_JUMP_MS) {
      signedIn.push(account);
    }
    next[key] = account.loginExpiresAt;
  }
  return { signedIn, seen: next };
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
