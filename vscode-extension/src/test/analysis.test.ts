/**
 * Tests for the pure analysis layer.
 *
 * Uses node:test so the suite needs no dependencies and no VS Code instance.
 * Run with `npm test` (compiles first, then `node --test out/test/`).
 *
 * Each test is named as a statement about behaviour, so a failure reads as a
 * description of what broke.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BurnRate,
  LEASE_STALE_MS,
  UsageSample,
  bindingWindow,
  computeBurnRate,
  earliestFiveHourReset,
  effectiveUsage,
  formatMinutes,
  hasHeadroom,
  hiddenModelConstraint,
  recordSample,
  leaseVerdict,
  worstScopedWindow,
} from '../analysis';
import { Account, Usage } from '../types';

const MIN = 60_000;

function account(over: Partial<Account> = {}): Account {
  return {
    number: 1,
    email: 'a@example.com',
    organizationUuid: 'org-1',
    active: false,
    usageStatus: 'ok',
    usage: null,
    ...over,
  };
}

function usage(fiveHourPct?: number, sevenDayPct?: number): Usage {
  const out: Usage = {};
  if (fiveHourPct !== undefined) {
    out.fiveHour = { pct: fiveHourPct };
  }
  if (sevenDayPct !== undefined) {
    out.sevenDay = { pct: sevenDayPct };
  }
  return out;
}

/** Samples rising at a known rate inside one window generation. */
function risingSamples(opts: {
  startPct: number;
  pctPerHour: number;
  count: number;
  gapMinutes: number;
  generation: string;
  startTs?: number;
}): UsageSample[] {
  const startTs = opts.startTs ?? 1_000_000_000_000;
  const out: UsageSample[] = [];
  for (let i = 0; i < opts.count; i++) {
    const hours = (i * opts.gapMinutes) / 60;
    out.push({
      ts: startTs + i * opts.gapMinutes * MIN,
      fiveHourPct: opts.startPct + opts.pctPerHour * hours,
      fiveHourResetsAt: opts.generation,
    });
  }
  return out;
}

describe('effectiveUsage', () => {
  it('prefers live usage over the last known measurement', () => {
    const result = effectiveUsage(
      account({ usage: usage(10), lastGoodUsage: usage(99) })
    );
    assert.equal(result?.stale, false);
    assert.equal(result?.usage.fiveHour?.pct, 10);
  });

  it('falls back to the last known measurement and marks it stale', () => {
    const result = effectiveUsage(
      account({ usage: null, usageStatus: 'unavailable', lastGoodUsage: usage(42) })
    );
    assert.equal(result?.stale, true);
    assert.equal(result?.usage.fiveHour?.pct, 42);
  });

  it('reports nothing when no measurement exists at all', () => {
    assert.equal(effectiveUsage(account({ usage: null })), undefined);
  });
});

describe('bindingWindow', () => {
  it('picks whichever of the two account windows is more consumed', () => {
    assert.equal(bindingWindow(usage(20, 70))?.label, '7d');
    assert.equal(bindingWindow(usage(80, 30))?.label, '5h');
  });

  it('prefers the 5-hour window when the two are equal', () => {
    assert.equal(bindingWindow(usage(50, 50))?.label, '5h');
  });

  it('handles an account reporting only one window', () => {
    assert.equal(bindingWindow(usage(33, undefined))?.label, '5h');
    assert.equal(bindingWindow(usage(undefined, 33))?.label, '7d');
  });

  it('reports nothing when no windows are present', () => {
    assert.equal(bindingWindow({}), undefined);
  });

  it('never returns a per-model window, because auto-switch ignores those', () => {
    const withModel: Usage = {
      ...usage(10, 20),
      scoped: [{ pct: 95, name: 'Fable' }],
    };
    const binding = bindingWindow(withModel);
    assert.equal(binding?.label, '7d');
    assert.equal(binding?.window.pct, 20);
  });
});

describe('worstScopedWindow', () => {
  it('returns the most consumed model window', () => {
    const u: Usage = { scoped: [{ pct: 12, name: 'Opus' }, { pct: 88, name: 'Fable' }] };
    assert.equal(worstScopedWindow(u)?.name, 'Fable');
  });

  it('reports nothing when no model windows are present', () => {
    assert.equal(worstScopedWindow({}), undefined);
    assert.equal(worstScopedWindow({ scoped: [] }), undefined);
  });
});

describe('hiddenModelConstraint', () => {
  it('flags a model window far above the account windows', () => {
    const u: Usage = { ...usage(30, 30), scoped: [{ pct: 95, name: 'Fable' }] };
    assert.equal(hiddenModelConstraint(u)?.name, 'Fable');
  });

  it('stays silent when the model window merely tracks the account window', () => {
    const u: Usage = { ...usage(60, 62), scoped: [{ pct: 64, name: 'Fable' }] };
    assert.equal(hiddenModelConstraint(u), undefined);
  });

  it('stays silent when there are no model windows', () => {
    assert.equal(hiddenModelConstraint(usage(90, 90)), undefined);
  });
});

describe('hasHeadroom', () => {
  it('is true below the threshold and false at or above it', () => {
    assert.equal(hasHeadroom(account({ usage: usage(50, 10) }), 90), true);
    assert.equal(hasHeadroom(account({ usage: usage(95, 10) }), 90), false);
    assert.equal(hasHeadroom(account({ usage: usage(90, 10) }), 90), false);
  });

  it('treats a disabled account as unavailable however much quota it has', () => {
    assert.equal(hasHeadroom(account({ usage: usage(0, 0), disabled: true }), 90), false);
  });

  it('treats an API-key account as always available, since it has no quota', () => {
    assert.equal(
      hasHeadroom(account({ usage: null, usageStatus: 'api_key' }), 90),
      true
    );
  });

  it('treats an account with no measurement as unavailable', () => {
    assert.equal(hasHeadroom(account({ usage: null, usageStatus: 'unavailable' }), 90), false);
  });

  it('uses the last known measurement when live usage is missing', () => {
    const a = account({ usage: null, usageStatus: 'unavailable', lastGoodUsage: usage(10, 10) });
    assert.equal(hasHeadroom(a, 90), true);
  });
});

describe('earliestFiveHourReset', () => {
  it('returns the soonest reset across accounts', () => {
    const soon = '2026-01-01T10:00:00Z';
    const later = '2026-01-01T12:00:00Z';
    const accounts = [
      account({ usage: { fiveHour: { pct: 99, resetsAt: later } } }),
      account({ number: 2, usage: { fiveHour: { pct: 99, resetsAt: soon } } }),
    ];
    assert.equal(earliestFiveHourReset(accounts), Date.parse(soon));
  });

  it('ignores disabled accounts, which cannot be switched onto', () => {
    const accounts = [
      account({ disabled: true, usage: { fiveHour: { pct: 99, resetsAt: '2026-01-01T09:00:00Z' } } }),
      account({ number: 2, usage: { fiveHour: { pct: 99, resetsAt: '2026-01-01T11:00:00Z' } } }),
    ];
    assert.equal(earliestFiveHourReset(accounts), Date.parse('2026-01-01T11:00:00Z'));
  });

  it('ignores an unparseable or absent reset time rather than throwing', () => {
    const accounts = [
      account({ usage: { fiveHour: { pct: 0 } } }),
      account({ number: 2, usage: { fiveHour: { pct: 0, resetsAt: 'not a date' } } }),
    ];
    assert.equal(earliestFiveHourReset(accounts), undefined);
  });
});

describe('computeBurnRate', () => {
  it('recovers a known constant rate', () => {
    const samples = risingSamples({
      startPct: 10, pctPerHour: 12, count: 6, gapMinutes: 10, generation: 'gen-1',
    });
    const rate = computeBurnRate(samples) as BurnRate;
    assert.ok(rate, 'expected a rate');
    assert.ok(Math.abs(rate.pctPerHour - 12) < 0.001, `got ${rate.pctPerHour}`);
  });

  it('projects the time remaining until the window is full', () => {
    // At 45%, rising 10 pct/hour: 55 points left = 5.5 hours = 330 minutes.
    const samples = risingSamples({
      startPct: 15, pctPerHour: 10, count: 4, gapMinutes: 60, generation: 'gen-1',
    });
    const rate = computeBurnRate(samples) as BurnRate;
    assert.ok(Math.abs((rate.minutesToFull as number) - 330) < 1, `got ${rate.minutesToFull}`);
  });

  it('IGNORES samples from a previous window generation', () => {
    // The regression test for the whole design: a window that rolled over from
    // 90% back to 2% must not read as a large negative rate.
    const old = risingSamples({
      startPct: 60, pctPerHour: 15, count: 4, gapMinutes: 15, generation: 'gen-OLD',
    });
    const fresh = risingSamples({
      startPct: 2, pctPerHour: 8, count: 4, gapMinutes: 15,
      generation: 'gen-NEW',
      startTs: old[old.length - 1].ts + 10 * MIN,
    });
    const rate = computeBurnRate([...old, ...fresh]) as BurnRate;
    assert.ok(rate.pctPerHour > 0, `rate should be positive, got ${rate.pctPerHour}`);
    assert.ok(Math.abs(rate.pctPerHour - 8) < 0.001, `got ${rate.pctPerHour}`);
    assert.equal(rate.sampleCount, 4, 'only the current generation should be counted');
  });

  it('reports nothing when there are too few samples to be meaningful', () => {
    const samples = risingSamples({
      startPct: 10, pctPerHour: 10, count: 2, gapMinutes: 30, generation: 'gen-1',
    });
    assert.equal(computeBurnRate(samples), undefined);
  });

  it('reports nothing when the samples span too short a time', () => {
    const samples = risingSamples({
      startPct: 10, pctPerHour: 10, count: 4, gapMinutes: 2, generation: 'gen-1',
    });
    assert.equal(computeBurnRate(samples), undefined);
  });

  it('gives no projection when usage is flat, rather than claiming forever', () => {
    const samples = risingSamples({
      startPct: 40, pctPerHour: 0, count: 5, gapMinutes: 15, generation: 'gen-1',
    });
    const rate = computeBurnRate(samples) as BurnRate;
    assert.ok(rate, 'a flat rate is still a rate');
    assert.equal(rate.minutesToFull, null);
  });

  it('gives no projection when usage is falling', () => {
    const samples = risingSamples({
      startPct: 80, pctPerHour: -5, count: 5, gapMinutes: 15, generation: 'gen-1',
    });
    const rate = computeBurnRate(samples) as BurnRate;
    assert.ok(rate.pctPerHour < 0);
    assert.equal(rate.minutesToFull, null);
  });

  it('gives no projection once the window is already full', () => {
    const samples = risingSamples({
      startPct: 100, pctPerHour: 0, count: 5, gapMinutes: 15, generation: 'gen-1',
    });
    assert.equal((computeBurnRate(samples) as BurnRate).minutesToFull, null);
  });

  it('handles samples arriving out of order', () => {
    const samples = risingSamples({
      startPct: 10, pctPerHour: 12, count: 6, gapMinutes: 10, generation: 'gen-1',
    });
    const shuffled = [samples[3], samples[0], samples[5], samples[1], samples[4], samples[2]];
    const rate = computeBurnRate(shuffled) as BurnRate;
    assert.ok(Math.abs(rate.pctPerHour - 12) < 0.001, `got ${rate.pctPerHour}`);
  });

  it('reports nothing when the window has no generation identity', () => {
    const samples: UsageSample[] = [
      { ts: 1000, fiveHourPct: 10 },
      { ts: 1000 + 20 * MIN, fiveHourPct: 20 },
      { ts: 1000 + 40 * MIN, fiveHourPct: 30 },
    ];
    assert.equal(computeBurnRate(samples), undefined);
  });
});

describe('recordSample', () => {
  it('appends a sample that is far enough from the last', () => {
    const history: UsageSample[] = [{ ts: 0, fiveHourPct: 1 }];
    const next = recordSample(history, { ts: 10 * MIN, fiveHourPct: 5 });
    assert.equal(next.length, 2);
  });

  it('drops a sample that arrives too soon after the last', () => {
    const history: UsageSample[] = [{ ts: 0, fiveHourPct: 1 }];
    const next = recordSample(history, { ts: MIN, fiveHourPct: 5 });
    assert.equal(next.length, 1);
  });

  it('does not modify the array it was given', () => {
    const history: UsageSample[] = [{ ts: 0, fiveHourPct: 1 }];
    recordSample(history, { ts: 10 * MIN, fiveHourPct: 5 });
    assert.equal(history.length, 1);
  });

  it('keeps history bounded, discarding the oldest samples', () => {
    let history: UsageSample[] = [];
    for (let i = 0; i < 260; i++) {
      history = recordSample(history, { ts: i * 10 * MIN, fiveHourPct: i });
    }
    assert.equal(history.length, 200);
    // The newest sample survives; the oldest has been dropped.
    assert.equal(history[history.length - 1].fiveHourPct, 259);
    assert.ok((history[0].fiveHourPct as number) > 0);
  });
});

describe('formatMinutes', () => {
  it('formats durations the way a person would say them', () => {
    assert.equal(formatMinutes(0.5), 'less than a minute');
    assert.equal(formatMinutes(45), '45m');
    assert.equal(formatMinutes(60), '1h');
    assert.equal(formatMinutes(160), '2h 40m');
    assert.equal(formatMinutes(60 * 30), '1d 6h');
  });

  it('does not produce nonsense for a non-finite input', () => {
    assert.equal(formatMinutes(Number.POSITIVE_INFINITY), 'less than a minute');
    assert.equal(formatMinutes(Number.NaN), 'less than a minute');
  });
});

describe('hiddenModelConstraint with the real-world shape', () => {
  // These numbers are upstream's own test fixture (tests/test_oauth.py,
  // "weekly_scoped entries in limits[] surface as result['scoped'] by model name"),
  // which encodes a live API response: the account's weekly window at 72% while the
  // per-model Fable window is at 100%. That gap is the entire reason this warning
  // exists, so the test uses the observed numbers rather than invented ones.
  const liveShape: Usage = {
    fiveHour: { pct: 7 },
    sevenDay: { pct: 72 },
    scoped: [{ pct: 100, name: 'Fable', resetsAt: '2026-03-23T15:00:00+00:00', countdown: '3h 0m' }],
  };

  it('flags the Fable window that is 28 points past the account window', () => {
    const hidden = hiddenModelConstraint(liveShape);
    assert.equal(hidden?.name, 'Fable');
    assert.equal(hidden?.pct, 100);
  });

  it('still reports the account window as binding, because switching ignores models', () => {
    // The status bar and the switching policy must not disagree: auto-switch only
    // acts on 5h/7d unless autoswitch.model names a model.
    const binding = bindingWindow(liveShape);
    assert.equal(binding?.label, '7d');
    assert.equal(binding?.window.pct, 72);
  });

  it('keeps the model window out of headroom, so it cannot silently block a switch', () => {
    // At 72% weekly with a 90% threshold the account is still a valid target even
    // though its Fable quota is spent. That is claude-swap's behaviour, and the
    // extension must reflect it rather than invent a stricter rule.
    assert.equal(hasHeadroom(account({ usage: liveShape }), 90), true);
  });

  it('carries the model name through, since the fix instruction needs it', () => {
    // The notification tells the user to run
    // `cswap config set autoswitch.model <name>`, which is useless without the name.
    assert.equal(worstScopedWindow(liveShape)?.name, 'Fable');
  });
});

describe('leaseVerdict', () => {
  const PID = 4242;
  const STALE = LEASE_STALE_MS;

  it('claims the timer when no lease file exists', () => {
    assert.equal(leaseVerdict({ exists: false }, PID), 'claim');
  });

  it('refreshes a lease that is already ours', () => {
    assert.equal(leaseVerdict({ exists: true, ageMs: 1000, holderPid: PID }, PID), 'refresh');
  });

  it('stands down for another window holding a fresh lease', () => {
    assert.equal(leaseVerdict({ exists: true, ageMs: 1000, holderPid: 999 }, PID), 'stand-down');
  });

  it('takes over a lease abandoned by a closed or crashed window', () => {
    assert.equal(
      leaseVerdict({ exists: true, ageMs: STALE + 1, holderPid: 999 }, PID),
      'take-over'
    );
  });

  it('RESPECTS a just-created lease whose body has not been written yet', () => {
    // The regression test for a measured bug. An earlier version decided staleness
    // from the JSON body and read an unreadable body as abandoned. Between one
    // process creating the file and writing into it, the others saw it EMPTY,
    // deleted it and created their own - electing 3 leaders out of 8 racing
    // processes. A fresh mtime with no readable holder must mean "held".
    assert.equal(leaseVerdict({ exists: true, ageMs: 5, holderPid: undefined }, PID), 'stand-down');
  });

  it('still reclaims an OLD lease whose body is unreadable', () => {
    // The other half: an empty file left behind by a crash must not wedge the timer
    // forever just because its pid cannot be read.
    assert.equal(
      leaseVerdict({ exists: true, ageMs: STALE + 1, holderPid: undefined }, PID),
      'take-over'
    );
  });

  it('treats a file stamped in the future as held, not stale', () => {
    // Clock skew or a restored snapshot must never hand the timer to two windows;
    // a delayed tick is the cheaper failure.
    assert.equal(leaseVerdict({ exists: true, ageMs: -60_000, holderPid: 999 }, PID), 'stand-down');
  });

  it('stands down when the age cannot be established at all', () => {
    assert.equal(leaseVerdict({ exists: true, holderPid: 999 }, PID), 'stand-down');
    assert.equal(leaseVerdict({ exists: true, ageMs: Number.NaN, holderPid: 999 }, PID), 'stand-down');
  });
});
