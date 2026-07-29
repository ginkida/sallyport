"""Admission control for tool calls — the thing that lets N agents share one browser.

Until 0.17 every MCP tool call in the process queued on one global
``Bridge._call_lock``: the single browser can only do one thing at a time, so
serialising was the safe default. In broker mode that made agents block each
other outright — one session's 30 s ``wait_for`` stalled every other session's
next call for its full duration, and ``status`` was the only tool that could
answer meanwhile.

The lock is replaced by two cooperating pieces:

* :class:`LaneRegistry` — one serial lane per client (concurrency 1). This is
  what actually preserved correctness before: a client's
  ``ensure_owns → round-trip → record_result`` sequence is a check-then-act
  across an ``await``, and the extension's per-tab state (CDP attachment,
  ``@eN`` refs, snapshot object groups) tolerates no two concurrent calls on
  the SAME tab. Because tab ownership is exclusive per client (invariant #13),
  "one call in flight per client" implies "one call in flight per tab", so the
  per-tab guarantee survives while different clients run concurrently.
  Standalone (``client_id is None``) is a first-class key mapping to ONE shared
  lane, so single-client behaviour is byte-for-byte what it was.

* :class:`PermitPool` — a global cap on how many calls may be on the wire at
  once, so N sessions cannot flood the one MV3 service worker.

**Acquisition order is load-bearing: lane first, then permit.** The reverse
starves: a client that pipelines calls would take permits and then block on its
own lane while HOLDING them, so permits accumulate in tasks that cannot
progress. Lane-first bounds each client to at most ONE task waiting on the
pool, which makes the FIFO queue below round-robin across clients for free —
no scheduler needed.

The pool is deliberately NOT :class:`asyncio.Semaphore`: its fairness across
the supported Python range (3.10–3.12) is an implementation detail, and a
barging waiter is a starvation bug in exactly the multi-agent case this module
exists to fix. The queue here is explicitly FIFO and cannot barge.
"""

from __future__ import annotations

import asyncio
from collections import deque

# How many tool calls may be in flight to the extension at once. Chrome and CDP
# handle far more (DevTools alone opens several concurrent sessions), so this is
# a guard against a runaway/looping client monopolising the single MV3 service
# worker rather than a throughput tuning knob — and since each client is capped
# at one in-flight call by its lane, it only binds once more than this many
# sessions are busy simultaneously.
DEFAULT_MAX_CONCURRENT_CALLS = 8

# Longest a call may sit waiting for a permit before giving up. Bounded so a
# wedged browser surfaces as a legible, RETRYABLE failure instead of an opaque
# stall: nothing has been sent to the extension yet when this fires, which is
# exactly what makes `busy` safe to retry (unlike `extension_timeout`).
DEFAULT_QUEUE_TIMEOUT_S = 60.0


class PermitPool:
    """A counting semaphore with a strict FIFO queue and no barging.

    ``acquire`` never lets a fresh arrival overtake an already-queued waiter,
    even when a permit is free at that instant — that is the property
    :class:`asyncio.Semaphore` does not guarantee across versions, and the one
    that keeps a chatty client from starving a quiet one.
    """

    def __init__(self, size: int) -> None:
        if size < 1:
            raise ValueError("permit pool size must be >= 1")
        self._size = size
        self._free = size
        self._waiters: deque[asyncio.Future[None]] = deque()

    @property
    def size(self) -> int:
        return self._size

    @property
    def free(self) -> int:
        return self._free

    @property
    def waiting(self) -> int:
        return sum(1 for fut in self._waiters if not fut.done())

    async def acquire(self, timeout: float | None = None) -> None:
        """Take a permit, waiting at most ``timeout`` seconds.

        Raises :class:`asyncio.TimeoutError` on expiry — the caller maps it to a
        retryable error code. On cancellation or timeout a permit handed to us
        in the same tick is passed straight on to the next waiter rather than
        leaked.
        """
        self._drop_settled_waiters()
        if self._free > 0 and not self._waiters:
            self._free -= 1
            return
        fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.append(fut)
        try:
            if timeout is None:
                await fut
            else:
                await asyncio.wait_for(fut, timeout)
        except BaseException:
            # Timed out or cancelled. Two cases, and getting them the wrong way
            # round leaks a permit for the life of the process:
            #  - the permit was already granted (release() popped us and set the
            #    result) in the same tick the timeout fired: hand it onward;
            #  - we are still queued: leave the queue.
            if fut.done() and not fut.cancelled() and fut.exception() is None:
                self.release()
            else:
                try:
                    self._waiters.remove(fut)
                except ValueError:  # pragma: no cover - already popped
                    pass
            raise

    def release(self) -> None:
        """Return a permit, handing it directly to the longest-waiting caller."""
        while self._waiters:
            fut = self._waiters.popleft()
            if not fut.done():
                fut.set_result(None)
                return
        self._free = min(self._size, self._free + 1)

    def _drop_settled_waiters(self) -> None:
        while self._waiters and self._waiters[0].done():
            self._waiters.popleft()


class LaneRegistry:
    """``clientId -> asyncio.Lock``: one serial lane per MCP client.

    ``None`` (standalone / ``exec``) is a first-class key, so single-client mode
    keeps exactly one lane and therefore exactly today's serialised behaviour.
    """

    def __init__(self) -> None:
        self._lanes: dict[str | None, asyncio.Lock] = {}

    def lane(self, client_id: str | None) -> asyncio.Lock:
        lane = self._lanes.get(client_id)
        if lane is None:
            lane = asyncio.Lock()
            self._lanes[client_id] = lane
        return lane

    def drop(self, client_id: str | None) -> None:
        """Forget a disconnected client's lane.

        Broker clientIds are freshly minted per connection, so without this the
        map grows for the whole life of a long-running broker. Safe even in the
        (unreachable) case where the lane is still held: the holder keeps its
        own reference and releasing an orphaned lock affects nobody.
        """
        self._lanes.pop(client_id, None)

    def __len__(self) -> int:
        return len(self._lanes)
