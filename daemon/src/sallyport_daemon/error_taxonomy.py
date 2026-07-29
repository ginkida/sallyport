"""Static recovery hints for tool-error codes.

A frozen, repo-authored table keyed by the stable ``BridgeError`` / ``ToolError``
code strings (the same tokens that already round-trip on the wire). When a tool
call fails with a known code, :func:`format_error_hint` yields one compact,
machine-readable line that the MCP layer appends *after* the human ``Error
[code]: message`` text (the human line stays byte-identical). It tells a tight
autonomous loop whether the failure is worth retrying and how to recover —
"when I see code X do Y" — without per-tool wiring.

Security: this is purely advisory and keyed only by the daemon's own verified
code constants — a compromised page controls only the ``code`` string, which
already round-trips today, and the daemon still enforces every gate on each
actual retry. The recovery text deliberately describes only **user-driven
popup steps** or **structured-tool alternatives**; it NEVER suggests flipping
``allowPassword`` / ``allowEvaluate`` as an automatic action, so it can't be
read as a way to talk the bridge into weakening invariant #4 or #5. Codes that
are *success, not error* (``wait_for`` / ``settle`` returning ``found:false`` /
``settled:false``) deliberately have no entry — they never reach the error path.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

# code -> compact recovery line. Each value embeds a `retryable=yes|no` flag so
# a loop can branch programmatically, followed by the human-actionable recovery.
_ERROR_HINTS: Mapping[str, str] = MappingProxyType(
    {
        "domain_not_allowed": (
            "retryable=no; the page's domain isn't in the allowlist — the user must add it "
            "in the extension popup (Allowlist tab); list_tabs shows which tabs you can "
            "already drive."
        ),
        "evaluate_not_allowed": (
            "retryable=no; this domain hasn't enabled evaluate — prefer the structured "
            "tools (click/fill/read_text/find/fetch_in_page); enabling evaluate is a "
            "user decision in the popup, not something to retry."
        ),
        "password_field": (
            "retryable=no; refusing to type into a password field — this needs explicit "
            "user intent, not an automatic retry; pick a non-password field if that was a "
            "mis-target."
        ),
        "tab_not_visible": (
            "retryable=yes; a hidden tab can't render a frame — in standalone mode "
            "activate it first (screenshot bringToFront=true, or switch to it) then "
            "retry; in broker mode bringToFront is forbidden (bringtofront_forbidden), "
            "so use snapshot/read_text instead, which don't need a visible tab."
        ),
        "pdf_too_large": (
            "retryable=no; the generated PDF exceeds the bridge frame cap — shrink the "
            "page first (smaller scale, print stylesheet) or capture the needed region "
            "with screenshot instead."
        ),
        "not_visible": (
            "retryable=yes; the target has zero size / isn't laid out yet — wait_for (or "
            "settle) until it renders then retry, or re-snapshot to pick a visible element."
        ),
        "bad_ref": (
            "retryable=yes; the @eN ref is stale (the page re-rendered or navigated) — run "
            "snapshot/find for a fresh ref then retry; get_state reports {exists:false} "
            "without erroring."
        ),
        "not_found": (
            "retryable=yes; no element matched — confirm it has rendered with find or "
            "wait_for, then retry with a fresh selector/@eN."
        ),
        "wrong_element": (
            "retryable=no; the target isn't the expected element type (e.g. select_option "
            "on a custom combobox) — open it with click/mouse_click and pick the option "
            "with click (find/reveal locate it)."
        ),
        "not_focusable": (
            "retryable=maybe; the fill target couldn't take focus (a wrapper div, a "
            "disabled/detached node) so insertText would type elsewhere — target the actual "
            "input/textarea/contenteditable (snapshot/find it), or use method:value."
        ),
        "unsafe_path": (
            "retryable=no; the path is outside the sandbox — place the file under "
            "~/Downloads/sallyport/ (or SALLYPORT_DOWNLOAD_DIR) and retry; save_to_file "
            "writes there."
        ),
        "filesystem_error": (
            "retryable=maybe; save_to_file couldn't create the download dir or write the "
            "file (permission denied, read-only volume, or disk full — the message says "
            "which) — free or fix ~/Downloads/sallyport/ (or set SALLYPORT_DOWNLOAD_DIR to a "
            "writable dir), then retry."
        ),
        "attach_debugger_conflict": (
            "retryable=yes; another client holds the tab (DevTools open / another extension "
            "/ a tab mid-drag) — close DevTools or retry shortly."
        ),
        "attach_target_closed": (
            "retryable=no; the target tab is gone — re-run list_tabs and pick a live tab, "
            "or navigate with newTab=true."
        ),
        "attach_forbidden_url": (
            "retryable=no; this page can't be debugged (chrome://, devtools://, the web "
            "store) — operate on a normal http(s) tab instead."
        ),
        "attach_failed": (
            "retryable=yes; the debugger attach failed — retry once; if it persists, check "
            "the tab is a normal page and reload it."
        ),
        "unserialisable_result": (
            "retryable=no; the result couldn't be serialised for the wire — narrow the "
            "request (scope a snapshot, lower maxChars) so the payload is smaller/plainer."
        ),
        "tab_required": (
            "retryable=yes; broker mode has no active-tab fallback — pass an explicit tabId "
            "of a tab you created (navigate with newTab:true makes one; list_tabs shows the "
            "tabs you own), then retry."
        ),
        "tab_not_owned": (
            "retryable=no; you can only drive tabs you created — not another client's or the "
            "human's; create one with navigate(newTab:true) or pick one from list_tabs "
            "(which shows only your tabs)."
        ),
        "tab_gone": (
            "retryable=no; the tab you targeted has closed or its id was recycled — open a "
            "fresh one with navigate(newTab:true); list_tabs shows the tabs still available."
        ),
        "window_create_failed": (
            "retryable=maybe; the browser couldn't open the dedicated agent window (broker "
            "mode opens agent tabs in their own non-focused window) — retry "
            "navigate(newTab:true); if it persists the browser may be low on resources, so "
            "check the Sallyport popup shows the extension attached."
        ),
        "bringtofront_forbidden": (
            "retryable=no; broker mode won't foreground a tab (it would steal the human's "
            "focus) — snapshot/read_text need no visible tab; screenshot works only when the "
            "tab is already the active one in its window."
        ),
        "not_connected": (
            "retryable=yes; no extension is attached right now — it auto-reconnects with "
            "backoff, so poll the status builtin until connected=true instead of burning the "
            "tool timeout; if it never connects, open Chrome and check the Sallyport popup is "
            "paired and not paused."
        ),
        "bad_args": (
            "retryable=no; the arguments don't match the tool's schema (the message says which "
            "field) — fix the call before retrying; an identical retry fails the same way."
        ),
        "bad_key": (
            "retryable=no; send_keys got an unrecognised key or modifier (the message names "
            "it) — keys are single letters/digits, Enter/Escape/Tab/Backspace/Delete/Space, "
            "arrows, Home/End/PageUp/PageDown or F1-F12; modifiers are mod/ctrl/cmd/shift/alt; "
            "fix the spec, an identical retry fails the same way."
        ),
        "paused": (
            "retryable=no while paused; the user paused Sallyport from the popup — ask them to "
            "click Resume, then retry (poll status to see when it clears)."
        ),
        "no_active_tab": (
            "retryable=yes; there's no active tab to fall back to — pass an explicit tabId "
            "(list_tabs shows candidates) or navigate(newTab:true) to make one, then retry."
        ),
        "snapshot_failed": (
            "retryable=yes; the snapshot couldn't be built (the page was mid-render or "
            "navigating) — settle or wait_for a concrete selector, then re-snapshot."
        ),
        "fetch_failed": (
            "retryable=maybe; the in-page fetch failed (network error, CORS, or a blocked "
            "request) — verify the URL and that its host is allowlisted, then retry."
        ),
        "eval_threw": (
            "retryable=no; the evaluated JavaScript threw (the message carries the page error) "
            "— fix the script before retrying; an identical retry throws the same way."
        ),
        "no_url": (
            "retryable=no; the tab has no navigable URL yet (a blank/new tab) — navigate to a "
            "page first, then retry."
        ),
        "unknown_tool": (
            "retryable=no; no tool by that name is registered — check the advertised tool list; "
            "a retry with the same name won't succeed."
        ),
        "timeout": (
            "retryable=maybe; the page-load watchdog fired (30s) without the tab reaching "
            "'complete' — thrown by navigate, reload (bypassCache or not) and history_go, which "
            "all share the same watchdog. The page may just be slow/heavy, or stuck loading; "
            "wait_for/settle on a concrete selector instead of relying on full page load. For "
            "navigate/reload it's safe to retry the SAME tool (navigate needs a URL; reload just "
            "needs the tabId) — both are idempotent. For history_go, do NOT blindly retry: "
            "Page.navigateToHistoryEntry fires and can complete BEFORE this watchdog does, so a "
            "timeout likely means the hop already landed and only 'reached complete' timed out — "
            "retrying would move further than intended. Instead read_text/snapshot the tab to see "
            "where it actually landed, or wait_for/settle a concrete selector."
        ),
        "extension_timeout": (
            "retryable=no; the call reached the extension but no reply came back inside the "
            "daemon's request window — the browser action may STILL be running (or may have "
            "already completed), so a blind retry can double-act (navigate twice, click twice). "
            "Read the tab's actual state first with snapshot/read_text/get_state, then decide. "
            "Distinct from `timeout`, which is the extension's own page-load watchdog."
        ),
        "busy": (
            "retryable=yes; every browser slot was occupied by other sessions for the whole "
            "queue window, so this call was never sent — nothing happened in the browser, which "
            "is what makes an immediate retry safe. Back off briefly first; `status` reports "
            "maxConcurrentCalls and your own pendingCalls."
        ),
        "no_history": (
            "retryable=no; the tab's session history doesn't reach that far in that direction "
            "(the message says how far it does) — reduce steps, flip direction, or navigate to "
            "an explicit URL instead; an identical retry fails the same way."
        ),
        "navigation_cancelled": (
            "retryable=maybe; history_go's hop did not actually happen — the tab is still on "
            "its previous page, most likely because a beforeunload prompt was dismissed (by "
            "handle_dialog's default policy, or a human). Check where you actually are with "
            "read_text/snapshot before deciding whether to retry; if you need to leave the page "
            "regardless, arm handle_dialog to accept the NEXT beforeunload first."
        ),
        "focus_probe_failed": (
            "retryable=no; key_type/send_keys couldn't verify the focused field is safe to type "
            "into (the CDP frame/AX/DOM focus walk returned incomplete data) — use fill instead "
            "with an explicit field selector/ref, or inspect the field first with "
            "snapshot/get_state."
        ),
        "error": (
            "retryable=maybe; an unclassified tool failure (the message carries whatever detail "
            "is available) — re-check the call's arguments and target tab/element before retrying; "
            "if it recurs identically, treat it as non-retryable."
        ),
    }
)


def format_error_hint(code: str | None) -> str | None:
    """Return the compact ``hint: …`` recovery line for *code*, or ``None`` when
    the code has no entry (unknown, or a success-not-error condition). The MCP
    layer appends the returned line after the human error text."""
    if not code:
        return None
    entry = _ERROR_HINTS.get(code)
    return f"hint: {entry}" if entry else None


def known_codes() -> frozenset[str]:
    """The set of codes carrying a recovery hint — exposed for the anti-rot test
    that pins these against the real thrown-code universe."""
    return frozenset(_ERROR_HINTS)
