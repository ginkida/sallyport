"""Broker-mode tab ownership (security invariant #13).

The daemon is the authoritative ownership gate (the extension is identity-blind).
These tests pin the pure registry/gate/scope functions and then drive the wiring
through ``Bridge.call_tool`` with a stubbed extension round-trip, so the gate,
the create-recording, and the fail-closed ``list_tabs`` scoping are all covered
without a live browser.
"""

from __future__ import annotations

from typing import Any

import pytest

from sallyport_daemon.bridge import Bridge, ToolError
from sallyport_daemon.ownership import (
    EPOCH_ARG,
    OwnershipRegistry,
    ensure_owns,
    record_close,
    record_opened_tabs,
    record_result,
    scope_list_tabs,
    strip_opened_tab_epochs,
)

SECRET = bytes(32)


# --- registry --------------------------------------------------------------


def test_record_and_owns() -> None:
    reg = OwnershipRegistry()
    assert reg.owns("A", 5) is False
    reg.record_create("A", 5, "e1", opened_at=1.0, window=2)
    assert reg.owns("A", 5) is True
    assert reg.epoch_for("A", 5) == "e1"
    assert reg.owned_tab_ids("A") == {5}
    # Other clients see nothing.
    assert reg.owns("B", 5) is False
    assert reg.owned_tab_ids("B") == set()


def test_owns_rejects_non_int_tabid() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, "e1", opened_at=1.0)
    assert reg.owns("A", "5") is False
    assert reg.owns("A", None) is False


def test_owns_rejects_bool_tabid_even_when_int_key_collides() -> None:
    """`isinstance(True, int)` is True and `True == 1` / `False == 0`, so a JSON
    `true`/`false` tabId would otherwise slip the ownership gate onto owned tab
    id 1/0 (`True in {1: ...}` is True). `type(x) is int` must reject bools
    regardless of a colliding owned int key, and record_create must not let a
    bool key clobber the int-1 entry (invariant #13)."""
    reg = OwnershipRegistry()
    reg.record_create("A", 1, "e1", opened_at=1.0)
    reg.record_create("A", 0, "e0", opened_at=1.0)
    assert reg.owns("A", 1) is True
    assert reg.owns("A", 0) is True
    assert reg.owns("A", True) is False
    assert reg.owns("A", False) is False
    # A bool tabId must not upsert (and must not clobber the int-1 entry).
    reg.record_create("A", True, "evil", opened_at=2.0)
    assert reg.epoch_for("A", 1) == "e1"
    assert reg.owned_tab_ids("A") == {0, 1}


def test_gate_rejects_bool_tabid() -> None:
    """End-to-end: even when the client owns tab id 1, a `tabId: true` act call
    is refused with tab_not_owned — never forwarded (where the extension would
    resolve a non-numeric tabId to the human's active tab)."""
    reg = OwnershipRegistry()
    reg.record_create("A", 1, "e1", opened_at=1.0)
    with pytest.raises(ToolError) as exc:
        ensure_owns(reg, "A", "click", {"tabId": True})
    assert exc.value.code == "tab_not_owned"


def test_record_create_does_not_clobber_epoch_with_none() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, "e1", opened_at=1.0, window=7)
    # An in-place re-navigate echoes the tabId but mints no epoch — keep e1.
    reg.record_create("A", 5, None, opened_at=2.0)
    assert reg.epoch_for("A", 5) == "e1"


def test_record_create_updates_epoch_when_provided() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, "e1", opened_at=1.0)
    reg.record_create("A", 5, "e2", opened_at=2.0)
    assert reg.epoch_for("A", 5) == "e2"


def test_record_create_ignores_non_int_tabid() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", "5", "e1", opened_at=1.0)
    assert reg.owned_tab_ids("A") == set()


def test_drop_tab_and_release_client() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, "e1", opened_at=1.0)
    reg.record_create("A", 6, "e2", opened_at=1.0)
    reg.drop_tab("A", 5)
    assert reg.owned_tab_ids("A") == {6}
    reg.drop_tab("A", 999)  # absent — no error
    released = reg.release_client("A")
    assert set(released) == {6}
    assert reg.owned_tab_ids("A") == set()
    assert reg.release_client("A") == {}  # idempotent


def test_drop_tab_for_a_client_with_no_owned_tabs_at_all() -> None:
    """A client_id that never created a tab has no entry in `_owned` at all
    (as opposed to an empty/emptied dict) — the `owned is not None` guard's
    False arm, distinct from the "tab id absent within an existing client"
    case covered above."""
    reg = OwnershipRegistry()
    reg.drop_tab("never-seen-client", 5)  # no error, no entry ever created
    assert reg.owned_tab_ids("never-seen-client") == set()


# --- ensure_owns gate ------------------------------------------------------


def test_gate_standalone_is_noop() -> None:
    reg = OwnershipRegistry()
    # No client id => standalone: even a tabId-less act tool passes untouched.
    assert ensure_owns(reg, None, "click", {}) == {}
    assert ensure_owns(reg, None, "snapshot", {"tabId": 99}) == {"tabId": 99}


def test_gate_list_tabs_is_ungated() -> None:
    reg = OwnershipRegistry()
    assert ensure_owns(reg, "A", "list_tabs", {}) == {}


def test_gate_navigate_create_own_allowed() -> None:
    reg = OwnershipRegistry()
    # navigate with no tabId is a create-own; allowed, args unchanged.
    assert ensure_owns(reg, "A", "navigate", {"url": "https://x"}) == {"url": "https://x"}


def test_gate_navigate_in_place_requires_ownership() -> None:
    reg = OwnershipRegistry()
    with pytest.raises(ToolError) as exc:
        ensure_owns(reg, "A", "navigate", {"tabId": 5, "url": "https://x"})
    assert exc.value.code == "tab_not_owned"


def test_gate_act_tool_missing_tabid_is_tab_required() -> None:
    reg = OwnershipRegistry()
    with pytest.raises(ToolError) as exc:
        ensure_owns(reg, "A", "click", {})
    assert exc.value.code == "tab_required"


def test_gate_act_tool_unowned_tabid_is_tab_not_owned() -> None:
    reg = OwnershipRegistry()
    reg.record_create("B", 5, "e1", opened_at=1.0)  # owned by someone else
    with pytest.raises(ToolError) as exc:
        ensure_owns(reg, "A", "click", {"tabId": 5})
    assert exc.value.code == "tab_not_owned"


def test_gate_owned_tab_injects_epoch() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, "e1", opened_at=1.0)
    out = ensure_owns(reg, "A", "click", {"tabId": 5})
    assert out == {"tabId": 5, EPOCH_ARG: "e1"}


def test_gate_owned_tab_without_epoch_forwards_as_is() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, None, opened_at=1.0)  # epoch not yet known
    out = ensure_owns(reg, "A", "click", {"tabId": 5})
    assert out == {"tabId": 5}
    assert EPOCH_ARG not in out


def test_gate_does_not_mutate_input_args() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, "e1", opened_at=1.0)
    args = {"tabId": 5}
    ensure_owns(reg, "A", "click", args)
    assert args == {"tabId": 5}  # epoch injected into a COPY, not the original


# --- record_result ---------------------------------------------------------


def test_record_result_standalone_noop() -> None:
    reg = OwnershipRegistry()
    record_result(reg, None, "navigate", {"tabId": 5, "epoch": "e1"}, opened_at=1.0)
    assert reg.owned_tab_ids("A") == set()


def test_record_result_non_create_tool_noop() -> None:
    reg = OwnershipRegistry()
    record_result(reg, "A", "snapshot", {"tabId": 5, "epoch": "e1"}, opened_at=1.0)
    assert reg.owned_tab_ids("A") == set()


def test_record_result_records_created_tab() -> None:
    reg = OwnershipRegistry()
    record_result(reg, "A", "navigate", {"tabId": 5, "epoch": "e1", "url": "x"}, opened_at=1.0)
    assert reg.owns("A", 5)
    assert reg.epoch_for("A", 5) == "e1"


def test_record_result_tolerates_missing_epoch_and_bad_shapes() -> None:
    reg = OwnershipRegistry()
    record_result(reg, "A", "navigate", {"tabId": 5}, opened_at=1.0)  # no epoch yet
    assert reg.owns("A", 5)
    assert reg.epoch_for("A", 5) is None
    record_result(reg, "A", "navigate", "not-a-dict", opened_at=1.0)  # ignored
    record_result(reg, "A", "navigate", {"url": "x"}, opened_at=1.0)  # no tabId, ignored
    assert reg.owned_tab_ids("A") == {5}


# --- scope_list_tabs (fail-closed) -----------------------------------------


def _tabs(*ids: int) -> dict[str, Any]:
    return {"tabs": [{"tabId": i, "url": f"https://{i}", "title": str(i)} for i in ids]}


def test_scope_standalone_returns_all() -> None:
    reg = OwnershipRegistry()
    data = _tabs(1, 2, 3)
    assert scope_list_tabs(reg, None, data) is data  # untouched


def test_scope_filters_to_owned() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 2, "e", opened_at=1.0)
    out = scope_list_tabs(reg, "A", _tabs(1, 2, 3))
    assert [t["tabId"] for t in out["tabs"]] == [2]


def test_scope_empty_owned_set_is_fail_closed() -> None:
    reg = OwnershipRegistry()
    out = scope_list_tabs(reg, "A", _tabs(1, 2, 3))
    assert out["tabs"] == []  # NEVER the whole profile


def test_scope_unknown_client_is_fail_closed() -> None:
    reg = OwnershipRegistry()
    reg.record_create("B", 1, "e", opened_at=1.0)
    out = scope_list_tabs(reg, "ghost", _tabs(1, 2, 3))
    assert out["tabs"] == []


def test_scope_drops_malformed_tab_entries() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 2, "e", opened_at=1.0)
    data = {"tabs": [{"tabId": 2}, "junk", {"url": "no-id"}, {"tabId": 9}]}
    out = scope_list_tabs(reg, "A", data)
    assert out["tabs"] == [{"tabId": 2}]


def test_scope_passthrough_for_non_tab_shapes() -> None:
    reg = OwnershipRegistry()
    assert scope_list_tabs(reg, "A", {"nope": 1}) == {"nope": 1}
    assert scope_list_tabs(reg, "A", "weird") == "weird"


def test_record_close_evicts_and_is_scoped() -> None:
    reg = OwnershipRegistry()
    reg.record_create("A", 5, "e1", opened_at=1.0)
    # Standalone / non-close / non-int tabId are all no-ops.
    record_close(reg, None, "close_tab", {"tabId": 5})
    record_close(reg, "A", "snapshot", {"tabId": 5})
    record_close(reg, "A", "close_tab", {"tabId": "x"})
    assert reg.owns("A", 5)
    # A real close on the owned tab evicts it.
    record_close(reg, "A", "close_tab", {"tabId": 5})
    assert not reg.owns("A", 5)


# --- Bridge.call_tool integration (stubbed extension) ----------------------


class _StubBridge(Bridge):
    """A Bridge whose extension round-trip is replaced by a canned-response stub,
    so the ownership wiring in ``call_tool`` is exercised without a live WS."""

    def __init__(self) -> None:
        super().__init__(secret=SECRET, host="127.0.0.1", port=10086)
        self.seen: list[tuple[str, dict[str, Any]]] = []
        self.responses: dict[str, Any] = {}

    async def _call_tool_locked(
        self, name: str, args: dict[str, Any], client_id: str | None = None
    ) -> Any:
        self.seen.append((name, dict(args)))
        return self.responses.get(name, {})


async def test_call_tool_records_create_then_gates_subsequent_calls() -> None:
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    b.responses["snapshot"] = {"ok": "snap"}

    # Create-own: navigate with no tabId mints tab 5, recorded as owned by A.
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    assert b._ownership.owns("A", 5)

    # Owned-tab call passes the gate AND carries the expected epoch to the ext.
    await b.call_tool("snapshot", {"tabId": 5}, client_id="A")
    assert b.seen[-1] == ("snapshot", {"tabId": 5, EPOCH_ARG: "e1"})


async def test_call_tool_strips_epoch_from_the_agent_facing_result() -> None:
    """`epoch` is internal ownership-registry bookkeeping (invariant #13) —
    record_result consumes it, but the agent (and the MCP schema) should
    never see it in the tool result."""
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    out = await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    assert out == {"tabId": 5, "url": "https://x"}
    assert "epoch" not in out
    # The registry still recorded it correctly despite the stripped result.
    assert b._ownership.epoch_for("A", 5) == "e1"


async def test_call_tool_unowned_tab_is_rejected_before_roundtrip() -> None:
    b = _StubBridge()
    with pytest.raises(ToolError) as exc:
        await b.call_tool("snapshot", {"tabId": 99}, client_id="A")
    assert exc.value.code == "tab_not_owned"
    assert b.seen == []  # never reached the extension


async def test_call_tool_missing_tabid_is_tab_required() -> None:
    b = _StubBridge()
    with pytest.raises(ToolError) as exc:
        await b.call_tool("click", {}, client_id="A")
    assert exc.value.code == "tab_required"
    assert b.seen == []


async def test_call_tool_cross_client_isolation() -> None:
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    # Client B cannot touch A's tab.
    with pytest.raises(ToolError) as exc:
        await b.call_tool("click", {"tabId": 5}, client_id="B")
    assert exc.value.code == "tab_not_owned"


async def test_call_tool_list_tabs_is_owner_scoped() -> None:
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    b.responses["list_tabs"] = _tabs(5, 6, 7)  # extension returned 3 tabs
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    out = await b.call_tool("list_tabs", {}, client_id="A")
    assert [t["tabId"] for t in out["tabs"]] == [5]  # only A's tab survives


async def test_call_tool_standalone_bypasses_ownership() -> None:
    b = _StubBridge()
    b.responses["click"] = {"clicked": True}
    # No client_id => standalone: tabId-less act tool reaches the extension.
    await b.call_tool("click", {}, client_id=None)
    assert b.seen == [("click", {})]


async def test_release_client_revokes_ownership() -> None:
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    b.release_client("A")
    with pytest.raises(ToolError) as exc:
        await b.call_tool("snapshot", {"tabId": 5}, client_id="A")
    assert exc.value.code == "tab_not_owned"


async def test_release_client_standalone_is_noop() -> None:
    b = _StubBridge()
    b.release_client(None)  # must not raise


async def test_call_tool_close_tab_evicts_ownership() -> None:
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    b.responses["close_tab"] = {"closed": 5}
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    assert b._ownership.owns("A", 5)
    # Closing the owned tab drops it from the registry (no unbounded growth).
    await b.call_tool("close_tab", {"tabId": 5}, client_id="A")
    assert not b._ownership.owns("A", 5)
    # And a later call on the recycled id is no longer owned.
    with pytest.raises(ToolError) as exc:
        await b.call_tool("snapshot", {"tabId": 5}, client_id="A")
    assert exc.value.code == "tab_not_owned"


async def test_status_is_owner_scoped_in_broker_mode() -> None:
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    # A makes a successful call; B trips the ownership gate (a recorded failure).
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    with pytest.raises(ToolError):
        await b.call_tool("click", {"tabId": 99}, client_id="B")

    a_status = await b.call_tool("status", {}, client_id="A")
    b_status = await b.call_tool("status", {}, client_id="B")

    # A sees only its own outcome — never B's tool, code, or the `client` tag.
    assert [e["tool"] for e in a_status["lastCalls"]] == ["navigate"]
    assert all("client" not in e for e in a_status["lastCalls"])
    assert a_status["lastError"] is None  # A had no failure
    # B sees only its own failure, not A's activity.
    assert [e["tool"] for e in b_status["lastCalls"]] == ["click"]
    assert all("client" not in e for e in b_status["lastCalls"])
    assert b_status["lastError"]["tool"] == "click"
    assert b_status["lastError"]["code"] == "tab_not_owned"


async def test_status_standalone_keeps_full_view() -> None:
    b = _StubBridge()
    b.responses["click"] = {"ok": True}
    await b.call_tool("click", {}, client_id=None)
    status = await b.call_tool("status", {}, client_id=None)
    # Standalone: the single-client view is unscoped and untagged.
    assert [e["tool"] for e in status["lastCalls"]] == ["click"]
    assert all("client" not in e for e in status["lastCalls"])


# --- tabs the PAGE opened --------------------------------------------------


def test_record_opened_tabs_records_each_entry() -> None:
    reg = OwnershipRegistry()
    record_opened_tabs(
        reg,
        "A",
        {"openedTabs": [{"tabId": 7, "epoch": "e7"}, {"tabId": 8, "epoch": "e8"}]},
        opened_at=1.0,
    )
    assert reg.owns("A", 7)
    assert reg.owns("A", 8)
    assert reg.epoch_for("A", 7) == "e7"


def test_record_opened_tabs_is_a_noop_in_standalone_and_on_junk() -> None:
    reg = OwnershipRegistry()
    record_opened_tabs(reg, None, {"openedTabs": [{"tabId": 7, "epoch": "e"}]}, opened_at=1.0)
    assert reg.owns("A", 7) is False
    # Malformed shapes record nothing rather than raising on a hot path.
    for junk in ({"openedTabs": "nope"}, {"openedTabs": [None, 5]}, {}, "not a dict"):
        record_opened_tabs(reg, "A", junk, opened_at=1.0)
    assert reg.owns("A", 7) is False


def test_strip_opened_tab_epochs_keeps_the_ids() -> None:
    """The epoch is registry bookkeeping; the tab ID is the whole point — without
    it the agent knows a tab opened but cannot name it."""
    out = strip_opened_tab_epochs({"ok": True, "openedTabs": [{"tabId": 7, "epoch": "e7"}]})
    assert out == {"ok": True, "openedTabs": [{"tabId": 7}]}
    # Nothing to strip is left exactly as it came.
    assert strip_opened_tab_epochs({"ok": True}) == {"ok": True}
    assert strip_opened_tab_epochs("x") == "x"


async def test_call_tool_adopts_a_tab_the_page_opened() -> None:
    """A target=_blank link, a window.open, an OAuth popup: the browser makes
    the tab, so it has no epoch of ours. The extension adopts it for the tab
    that spawned it — which this client already owns, since the call passed the
    gate — and the daemon records it here. Without this the tab is nameless to
    every client and invisible to owner-scoped list_tabs."""
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    b.responses["click"] = {"tabId": 5, "openedTabs": [{"tabId": 6, "epoch": "e6"}]}
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")

    out = await b.call_tool("click", {"tabId": 5, "selector": "a"}, client_id="A")

    # The new tab is owned, so the agent can drive it...
    assert b._ownership.owns("A", 6)
    assert b._ownership.epoch_for("A", 6) == "e6"
    # ...it is told the id...
    assert out == {"tabId": 5, "openedTabs": [{"tabId": 6}]}
    # ...and the epoch never reaches it.
    await b.call_tool("snapshot", {"tabId": 6}, client_id="A")
    assert b.seen[-1] == ("snapshot", {"tabId": 6, EPOCH_ARG: "e6"})


async def test_call_tool_adoption_does_not_cross_clients() -> None:
    b = _StubBridge()
    b.responses["navigate"] = {"tabId": 5, "epoch": "e1", "url": "https://x"}
    b.responses["click"] = {"tabId": 5, "openedTabs": [{"tabId": 6, "epoch": "e6"}]}
    await b.call_tool("navigate", {"url": "https://x"}, client_id="A")
    await b.call_tool("click", {"tabId": 5, "selector": "a"}, client_id="A")

    assert b._ownership.owns("B", 6) is False
