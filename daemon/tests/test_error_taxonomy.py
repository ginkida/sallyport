"""Tests for the static error-recovery taxonomy.

The table is repo-authored advisory data; these tests pin its shape (a hint for
known codes, nothing for unknown ones), keep it from rotting against the real
thrown-code universe, and enforce the security constraint that no hint ever
advertises a gate-relaxing flag as an automatic action.
"""

from __future__ import annotations

import re
from pathlib import Path

from sallyport_daemon.error_taxonomy import format_error_hint, known_codes

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _real_code_universe() -> set[str]:
    """Every error code actually thrown anywhere in the codebase.

    Mirrors the multi-line-tolerant extraction the taxonomy was built against:
    extension `new BridgeError('code', …)` literals (whitespace spans newlines),
    `code: 'x'` / `code = 'x'` assignments (ok:false results + classifyAttachError),
    and the daemon's own `code="x"` ToolError raises. A grep that misses
    multi-line throws would let the anti-rot test pass on a stale key, so this
    reads each file whole."""
    codes: set[str] = set()
    ext = "\n".join(
        p.read_text(encoding="utf-8") for p in (_REPO_ROOT / "extension" / "src").rglob("*.ts")
    )
    codes |= set(re.findall(r"new BridgeError\(\s*['\"]([a-z_]+)['\"]", ext))
    codes |= set(re.findall(r"code\s*[:=]\s*['\"]([a-z_]+)['\"]", ext))
    daemon = "\n".join(
        p.read_text(encoding="utf-8") for p in (_REPO_ROOT / "daemon" / "src").rglob("*.py")
    )
    codes |= set(re.findall(r'code=["\']([a-z_]+)["\']', daemon))
    return codes


def test_format_error_hint_known_code_returns_a_hint_line() -> None:
    hint = format_error_hint("bad_ref")
    assert hint is not None
    assert hint.startswith("hint: ")
    assert "retryable=" in hint


def test_format_error_hint_unknown_or_empty_returns_none() -> None:
    assert format_error_hint("some_unmapped_code") is None
    assert format_error_hint(None) is None
    assert format_error_hint("") is None


def test_every_taxonomy_key_is_a_real_thrown_code() -> None:
    """Anti-rot: a hint keyed to a code nothing throws is dead weight and a
    sign the code was renamed. Every key must exist in the real universe."""
    universe = _real_code_universe()
    # Sanity: the extraction found a plausible set (guards against a broken regex
    # silently making the subset check trivially pass).
    assert {"bad_ref", "domain_not_allowed", "attach_failed"} <= universe
    stale = known_codes() - universe
    assert not stale, f"taxonomy keys not found in any thrown code: {sorted(stale)}"


def test_no_hint_for_success_not_error_conditions() -> None:
    """wait_for/settle return settled:false / found:false (with a
    reason:'timeout' string) as SUCCESS, never a ToolError — those must not
    masquerade as recoverable errors. Note "timeout" itself IS a real thrown
    BridgeError code (the shared page-load watchdog in tabs.ts, thrown by
    both navigate and reload) distinct from wait_for/settle's non-error
    `reason` field of the same name, so it legitimately has a hint — only
    "settled"/"found" are checked here."""
    keys = known_codes()
    for not_an_error in ("settled", "found"):
        assert not_an_error not in keys


def test_timeout_hint_attributes_the_shared_watchdog_to_both_callers() -> None:
    """Regression: the "timeout" code is thrown by a single shared watchdog
    (tabs.ts:waitForLoad) used by BOTH navigate and reload — a hint that only
    mentions navigate misdirects an agent whose reload call timed out towards
    retrying the wrong tool (and one that needs a URL it may not have)."""
    hint = format_error_hint("timeout") or ""
    assert "navigate" in hint.lower()
    assert "reload" in hint.lower()


def test_timeout_hint_warns_history_go_is_not_safe_to_blindly_retry() -> None:
    """Regression: history_go ALSO shares tabs.ts:waitForLoad's watchdog, but
    unlike navigate/reload a blind retry isn't safe — Page.navigateToHistoryEntry
    can complete (the hop already landed) before the watchdog fires, so retrying
    the same call would move further than intended. The hint must name
    history_go AND carry guidance distinct from the "just retry" advice given
    for navigate/reload, or a future edit could silently drop this warning and
    reintroduce the over-navigation risk with the full suite still green."""
    hint = format_error_hint("timeout") or ""
    low = hint.lower()
    assert "history_go" in low
    assert "not" in low  # the non-retryable caveat, not just a mention
    assert "retry" in low
    assert "snapshot" in low or "read_text" in low  # how to check where it landed instead


def test_no_hint_advertises_a_gate_relaxing_flag() -> None:
    """Invariant #4/#5: a recovery hint must never tell the agent to flip
    allowPassword/allowEvaluate — those are user decisions, not auto-retries."""
    for code in known_codes():
        hint = format_error_hint(code) or ""
        low = hint.lower()
        assert "allowpassword" not in low, code
        assert "allowevaluate" not in low, code


def test_hints_are_single_compact_lines() -> None:
    """The hint is appended as ONE line after the human error — it must not
    itself contain a newline."""
    for code in known_codes():
        hint = format_error_hint(code)
        assert hint is not None
        assert "\n" not in hint
