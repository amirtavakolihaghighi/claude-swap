/**
 * Types for claude-swap's `--json` output.
 *
 * These mirror the schema-v1 contract defined in `src/claude_swap/json_output.py`
 * of the parent project. That contract is explicitly *additive*: new fields and
 * new event kinds may appear without a version bump, and only a breaking change
 * to an existing shape bumps `schemaVersion`. So every field added since the
 * original release is optional here, and unknown fields are ignored rather than
 * rejected.
 *
 * Shapes below were verified against real `cswap` output, not inferred from the
 * source alone — notably: `fiveHour` omits `resetsAt`/`countdown` entirely when
 * an account has used none of its 5-hour window, and `scoped` is an *array* of
 * per-model windows each carrying its own `name`, not a keyed object.
 */

/** A single usage window (5-hour, 7-day, or one per-model weekly window). */
export interface UsageWindow {
  pct: number;
  /** Absent when the window has seen no usage at all. */
  resetsAt?: string;
  /** Pre-formatted by cswap, e.g. "4h 54m" — display as-is. */
  countdown?: string;
  /** Pre-formatted local wall-clock reset, e.g. "Sep 24 01:50". */
  clock?: string;
  /** Per-model windows only: the model's display name, e.g. "Fable". */
  name?: string;

  // Pace fields. Weekly windows only (never fiveHour), and only once the week
  // is roughly a day old.
  /** Where usage would sit if spread evenly across the week. */
  expectedPct?: number;
  /** True when meaningfully above `expectedPct`. */
  aheadOfPace?: boolean;
  /** Linear extrapolation to 100%. Rough by design — treat as a hint. */
  projectedExhaustionAt?: string;
  /** False when the projection runs out before the weekly reset. */
  willLastToReset?: boolean;
}

export interface SpendWindow {
  used: number;
  limit: number;
  pct: number;
  currency: string;
  resetsAt?: string;
  countdown?: string;
  clock?: string;
}

export interface Usage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  spend?: SpendWindow;
  /** Per-model weekly windows; each entry carries a `name`. */
  scoped?: UsageWindow[];
}

/**
 * Why an account has no usable usage numbers. "ok" means `usage` is present.
 * The full set is produced by `json_output.usage_fields`.
 */
export type UsageStatus =
  | 'ok'
  | 'token_expired'
  | 'api_key'
  | 'keychain_unavailable'
  | 'relogin_required'
  | 'foreign_credential'
  | 'no_credentials'
  | 'unavailable';

export interface Account {
  number: number;
  email: string;
  organizationName?: string;
  organizationUuid?: string;
  isOrganization?: boolean;
  active: boolean;
  usageStatus: UsageStatus;
  usage: Usage | null;

  /** Present once set with `cswap alias`. */
  alias?: string;
  /** Present and true only when held out of rotation with `cswap disable`. */
  disabled?: boolean;
  /** When this stored login's refresh token expires (needs a fresh /login). */
  loginExpiresAt?: string;

  usageFetchedAt?: string;
  usageAgeSeconds?: number;

  /** Present when `usage` is null but an older measurement is still known. */
  lastGoodUsage?: Usage;
  lastGoodFetchedAt?: string;
  lastGoodAgeSeconds?: number;

  /** Names the last fetch failure by kind, e.g. "http-429", "timeout". */
  usageError?: string;
  usageRetryAt?: string;
}

export interface ListPayload {
  schemaVersion: number;
  activeAccountNumber: number | null;
  accounts: Account[];
}

/** `cswap status --json`. `active` is null when no managed account is live. */
export interface StatusPayload {
  schemaVersion: number;
  active: (Omit<Account, 'active' | 'number'> & { number: number | null; managed?: boolean }) | null;
  totalManagedAccounts?: number;
}

export interface AccountRef {
  number: number | null;
  email: string;
}

export interface SwitchPayload {
  schemaVersion: number;
  switched: boolean;
  from: AccountRef | null;
  to: AccountRef;
  strategy?: string;
  reason: string;
  message: string;
  warnings: string[];
}

/** The `{"error": {...}}` envelope cswap prints on a handled failure. */
export interface ErrorPayload {
  schemaVersion: number;
  error: { type: string; message: string };
}

/**
 * One line of `cswap auto --json`. The `event` set is open by contract —
 * observed kinds include poll, switch, no-switch, account-quarantined,
 * unquarantined, all-exhausted, config-warning and error.
 */
export interface AutoEvent {
  schemaVersion: number;
  event: string;
  ts: string;
  active?: AccountRef;
  from?: AccountRef;
  to?: AccountRef;
  reason?: string;
  detail?: string;
  message?: string;
  threshold?: number;
  headroomPct?: Record<string, number>;
  windowsPct?: Record<string, Record<string, number>>;
}

/**
 * Exit codes from `cswap auto --once`, which is built for exactly this kind of
 * scheduled single-shot invocation.
 */
export enum AutoOnceCode {
  Switched = 0,
  Error = 1,
  NothingToDo = 2,
  Blocked = 3,
}
