"""Per-client tab ownership for broker mode (security invariant #13).

In broker mode N MCP clients share one extension/browser. A client may act only
on tabs IT created; the human's tabs and other clients' tabs stay invisible and
untouchable. This module is the broker-side AUTHORITATIVE registry + gate — the
extension is identity-blind (one anonymous peer to the daemon) and only a
defense-in-depth layer, so all ownership policy lives here.

Keyed ``(clientId, tabId, epoch)``: Chrome recycles tab ids, so a create-time
``epoch`` — minted by the extension at ``chrome.tabs.create`` and echoed in the
result — disambiguates a reused id from the original tab. ``tabId`` alone is
never a safe key; ``(tabId, epoch)`` is.

Standalone mode (``clientId is None``) bypasses the gate entirely — there is one
client and today's behaviour (including the extension's active-tab fallback) is
preserved.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .bridge import ToolError

# Tools that may MINT a new owned tab (``tabId`` optional). A tabId-less call to
# one of these creates a tab the caller then owns; with a ``tabId`` it targets an
# existing owned tab like any other.
CREATE_CAPABLE = frozenset({"navigate"})

# Tool that DESTROYS a tab: on success its tabId leaves the owned set, so a long
# session that opens and closes many tabs doesn't accumulate dead ownership
# entries until the client disconnects.
CLOSE_TOOL = "close_tab"

# Extension tools that reach the browser but carry NO ownership requirement.
# ``list_tabs`` is metadata-only; it is owner-SCOPED (result post-filtered to the
# caller's tabs) rather than owner-GATED. Everything else that reaches the gate
# requires an owned tab — a fail-safe default for any future tab-touching tool.
UNGATED_TOOLS = frozenset({"list_tabs"})

# Field injected into a forwarded tool_call's args so the extension can confirm
# its local ``epochByTab[tabId]`` matches what the broker believes it owns — the
# tabId-recycling defence. Absent when the broker has no epoch on record yet.
EPOCH_ARG = "expectedEpoch"


@dataclass
class OwnedTab:
    """One owned tab. ``epoch`` is the extension's create-time marker (None until
    the extension echoes it); ``window`` is presentation only — ownership never
    keys on it (the human may drag a tab between windows)."""

    epoch: str | None
    opened_at: float
    window: int | None = None


class OwnershipRegistry:
    """``clientId -> {tabId -> OwnedTab}``. Lives on the shared :class:`Bridge`;
    one instance serves all broker connections (the Bridge owns the one
    extension). All access is serialised by ``Bridge._call_lock`` on the call
    path plus the synchronous ``release_client`` on disconnect, so no internal
    locking is needed."""

    def __init__(self) -> None:
        self._owned: dict[str, dict[int, OwnedTab]] = {}

    def owns(self, client_id: str, tab_id: Any) -> bool:
        return isinstance(tab_id, int) and tab_id in self._owned.get(client_id, {})

    def epoch_for(self, client_id: str, tab_id: int) -> str | None:
        tab = self._owned.get(client_id, {}).get(tab_id)
        return tab.epoch if tab is not None else None

    def owned_tab_ids(self, client_id: str) -> set[int]:
        return set(self._owned.get(client_id, {}))

    def record_create(
        self,
        client_id: str,
        tab_id: Any,
        epoch: Any,
        *,
        opened_at: float,
        window: Any = None,
    ) -> None:
        """Upsert ownership of a (possibly new) tab the client just created.
        Idempotent for an in-place re-navigate. Never clobbers a known ``epoch``
        with ``None`` — an in-place navigate echoes the tabId but mints no new
        epoch, so a missing epoch in the result means 'unchanged', not 'cleared'.
        """
        if not isinstance(tab_id, int):
            return
        tabs = self._owned.setdefault(client_id, {})
        existing = tabs.get(tab_id)
        eff_epoch = epoch if isinstance(epoch, str) else (existing.epoch if existing else None)
        eff_window = window if isinstance(window, int) else (existing.window if existing else None)
        tabs[tab_id] = OwnedTab(epoch=eff_epoch, opened_at=opened_at, window=eff_window)

    def drop_tab(self, client_id: str, tab_id: int) -> None:
        owned = self._owned.get(client_id)
        if owned is not None:
            owned.pop(tab_id, None)

    def release_client(self, client_id: str) -> dict[int, OwnedTab]:
        """Drop a client's whole ownership set on disconnect and return it, so
        the caller can move those tabs to an orphan pool. v1 keeps the tabs open
        and merely unowned — the human can use or close them."""
        return self._owned.pop(client_id, {})


def ensure_owns(
    registry: OwnershipRegistry,
    client_id: str | None,
    name: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Broker-mode ownership gate, run before the extension round-trip.

    Returns the args to forward — augmented with :data:`EPOCH_ARG` for an owned
    tab whose epoch is known, so the extension can confirm it. Raises
    ``ToolError(tab_required | tab_not_owned)``. No-op in standalone
    (``client_id is None``): returns ``args`` unchanged so today's single-client
    behaviour (incl. the extension's active-tab fallback) is preserved.
    """
    if client_id is None:
        return args
    if name in UNGATED_TOOLS:
        return args
    tab_id = args.get("tabId")
    if name in CREATE_CAPABLE and tab_id is None:
        return args  # create-own: the result's (tabId, epoch) is recorded after
    if tab_id is None:
        raise ToolError(
            f"{name} requires an explicit tabId in broker mode — the active-tab "
            "fallback is disabled; pass the tabId of a tab you created "
            "(navigate with newTab:true makes one)",
            code="tab_required",
        )
    if not registry.owns(client_id, tab_id):
        # ONE code collapses 'not yours' / 'never existed' / 'recycled to another
        # tab' so it can't be used as an existence/content oracle for the human's
        # live tabIds. Echoes no url/title (mirror Bridge's domain refusal).
        raise ToolError("tab is not owned by this client", code="tab_not_owned")
    epoch = registry.epoch_for(client_id, tab_id)
    if epoch is None:
        return args  # owned but epoch not yet known (reconciling) — forward as-is
    return {**args, EPOCH_ARG: epoch}


def record_result(
    registry: OwnershipRegistry,
    client_id: str | None,
    name: str,
    result: Any,
    *,
    opened_at: float,
) -> None:
    """After a successful create-capable call, record the (possibly new) owned
    tab from its result data. No-op in standalone or for non-create tools.

    Recording from ``navigate``'s result is safe: an in-place navigate only
    targets an already-owned tab (the gate enforced it), and ``newTab`` mints a
    fresh tab — so this can never grant ownership of a foreign/human tab."""
    if client_id is None or name not in CREATE_CAPABLE:
        return
    if not isinstance(result, dict):
        return
    tab_id = result.get("tabId")
    if not isinstance(tab_id, int):
        return
    registry.record_create(
        client_id,
        tab_id,
        result.get("epoch"),
        opened_at=opened_at,
        window=result.get("window"),
    )


def record_close(
    registry: OwnershipRegistry,
    client_id: str | None,
    name: str,
    args: dict[str, Any],
) -> None:
    """Evict an owned tab from the registry after a SUCCESSFUL ``close_tab`` so a
    long open/close-heavy session doesn't grow ``self._owned[clientId]`` without
    bound (the only other shrink path is ``release_client`` on disconnect). No-op
    in standalone or for any other tool. Call only after the gate AND the call
    succeeded — the tabId is the owned one ``ensure_owns`` already validated."""
    if client_id is None or name != CLOSE_TOOL:
        return
    tab_id = args.get("tabId")
    if isinstance(tab_id, int):
        registry.drop_tab(client_id, tab_id)


def scope_list_tabs(
    registry: OwnershipRegistry,
    client_id: str | None,
    data: Any,
) -> Any:
    """Owner-scope a ``list_tabs`` result to the caller's owned tabs — the
    daemon-side half of the two-layer filter (the extension filters too).

    FAIL-CLOSED: an unknown/empty ``client_id`` or empty owned-set yields an
    EMPTY tab list, NEVER the whole profile — a single filter bug must not leak
    the human's banking/email/SSO tab metadata. No-op in standalone
    (``client_id is None``)."""
    if client_id is None:
        return data
    if not isinstance(data, dict) or not isinstance(data.get("tabs"), list):
        return data
    owned = registry.owned_tab_ids(client_id)
    data["tabs"] = [t for t in data["tabs"] if isinstance(t, dict) and t.get("tabId") in owned]
    return data
