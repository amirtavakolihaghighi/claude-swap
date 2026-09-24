"""Does claude_swap.locking.FileLock exclude across OS PROCESSES?

This is the premise upstream's own concurrency test relies on but cannot check.
``test_locked_recheck_stops_concurrent_engine`` (tests/test_autoswitch.py) proves the
decision logic: a second engine's under-lock re-read sees the winner's persisted
``lastSwitchAt`` and backs off instead of double-switching. That argument only holds
if the state lock genuinely serialises the two — and upstream tests it with two engine
objects in ONE process. On Windows FileLock uses ``msvcrt.locking``, on POSIX
``fcntl.flock``: different mechanisms with different scope rules.

It matters because two VS Code windows each run the extension's auto-switch timer, so
each spawns its own ``cswap auto --once`` PROCESS. If the lock does not exclude across
processes, both could read state before either writes, and both switch.

Protocol: each child acquires the lock, appends "<id> start", holds briefly, appends
"<id> end", releases. Exclusion holds if and only if every start is immediately
followed by its own end. Interleaving ("A start, B start, A end, B end") is failure.
Total elapsed time is also checked against the serial floor, so a run that somehow
avoided interleaving by racing through cannot pass.

Measured 2026-09-24, Windows 10, Python 3.14: 5 processes, strictly serialised, zero
interleaving, 2.15s elapsed against a 1.75s floor.

Run from anywhere:
    python fork-tools/verification/filelock-crossprocess.py
Exit code 0 = exclusion holds, 1 = it does not.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

# Repo-relative, so this works on any checkout and leaks no local paths.
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

from claude_swap.locking import FileLock  # noqa: E402

HOLD_S = 0.35
N_CHILDREN = 5


def child(worker_id: str, log_path: Path, lock_path: Path) -> int:
    """Acquire, mark, hold, mark, release. 0 on success, 2 if never acquired."""
    lock = FileLock(lock_path, timeout=30.0)
    if not lock.acquire():
        return 2
    try:
        for phase in ("start", "end"):
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write(f"{worker_id} {phase:<5} {time.time():.4f}\n")
                fh.flush()
                os.fsync(fh.fileno())
            if phase == "start":
                time.sleep(HOLD_S)
    finally:
        lock.release()
    return 0


def parent() -> int:
    tmp = Path(__file__).parent
    log_path = tmp / ".locktest.log"
    lock_path = tmp / ".locktest.lock"
    for p in (log_path, lock_path):
        p.unlink(missing_ok=True)

    print(f"FileLock cross-process exclusion: {N_CHILDREN} processes, {HOLD_S}s hold each")
    print(f"platform: {sys.platform} "
          f"({'msvcrt.locking' if sys.platform == 'win32' else 'fcntl.flock'})")

    started = time.time()
    procs = [
        subprocess.Popen(
            [sys.executable, __file__, f"P{i}", str(log_path), str(lock_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for i in range(N_CHILDREN)
    ]
    codes = [p.wait(timeout=120) for p in procs]
    elapsed = time.time() - started

    print(f"\nchild exit codes: {codes}")
    if any(c != 0 for c in codes):
        for p in procs:
            err = p.stderr.read().decode(errors="replace") if p.stderr else ""
            if err.strip():
                print(f"  stderr: {err.strip()[:400]}")
        print("RESULT: FAIL - a child never acquired the lock, or errored")
        return 1

    lines = [l.strip() for l in log_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    print(f"\nlog ({len(lines)} lines, expected {N_CHILDREN * 2}):")
    for l in lines:
        print(f"  {l}")

    if len(lines) != N_CHILDREN * 2:
        print(f"\nRESULT: FAIL - expected {N_CHILDREN * 2} lines, got {len(lines)}")
        return 1

    interleaved = []
    for i in range(0, len(lines) - 1, 2):
        first, second = lines[i].split(), lines[i + 1].split()
        if first[0] != second[0] or first[1] != "start" or second[1] != "end":
            interleaved.append((lines[i], lines[i + 1]))

    print()
    if interleaved:
        print("RESULT: FAIL - holds INTERLEAVED; the lock does not exclude across processes")
        for a, b in interleaved:
            print(f"  {a}  ||  {b}")
        return 1

    floor = N_CHILDREN * HOLD_S
    serial = elapsed >= floor * 0.9
    print(f"RESULT: {'PASS' if serial else 'FAIL'} - "
          f"{N_CHILDREN} holds serialised, no interleaving")
    print(f"  elapsed {elapsed:.2f}s vs serial floor {floor:.2f}s "
          f"({'consistent' if serial else 'TOO FAST - they did not really queue'})")
    for p in (log_path, lock_path):
        p.unlink(missing_ok=True)
    return 0 if serial else 1


if __name__ == "__main__":
    if len(sys.argv) == 4:
        sys.exit(child(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])))
    sys.exit(parent())
