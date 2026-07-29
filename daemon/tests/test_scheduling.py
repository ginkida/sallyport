"""Admission control: FIFO permit pool + per-client lanes (scheduling.py).

These are the primitives that replaced the global call lock, so their fairness
properties are the ones that decide whether one busy agent can stall another.
"""

from __future__ import annotations

import asyncio

import pytest

from sallyport_daemon.scheduling import LaneRegistry, PermitPool

pytestmark = pytest.mark.asyncio


async def test_permits_up_to_size_are_granted_immediately() -> None:
    pool = PermitPool(2)
    await asyncio.wait_for(pool.acquire(), timeout=0.5)
    await asyncio.wait_for(pool.acquire(), timeout=0.5)
    assert pool.free == 0
    with pytest.raises(asyncio.TimeoutError):
        await pool.acquire(timeout=0.05)


async def test_release_hands_the_permit_to_the_waiter() -> None:
    pool = PermitPool(1)
    await pool.acquire()
    waiter = asyncio.create_task(pool.acquire())
    await asyncio.sleep(0)
    assert not waiter.done()
    pool.release()
    await asyncio.wait_for(waiter, timeout=0.5)
    # The permit went straight to the waiter rather than back into the pool.
    assert pool.free == 0


async def test_queue_is_fifo_and_a_newcomer_cannot_barge() -> None:
    """The property asyncio.Semaphore does not guarantee across versions, and
    the one that keeps a chatty client from starving a quiet one."""
    pool = PermitPool(1)
    await pool.acquire()
    order: list[str] = []

    async def contender(name: str) -> None:
        await pool.acquire()
        order.append(name)

    first = asyncio.create_task(contender("first"))
    await asyncio.sleep(0)
    second = asyncio.create_task(contender("second"))
    await asyncio.sleep(0)

    # A permit is free at this instant, but a fresh arrival must still queue
    # behind the two already waiting.
    pool.release()
    third = asyncio.create_task(contender("third"))
    await asyncio.sleep(0)
    pool.release()
    pool.release()

    await asyncio.wait_for(asyncio.gather(first, second, third), timeout=1.0)
    assert order == ["first", "second", "third"]


async def test_timed_out_waiter_leaves_the_queue_and_leaks_no_permit() -> None:
    pool = PermitPool(1)
    await pool.acquire()
    with pytest.raises(asyncio.TimeoutError):
        await pool.acquire(timeout=0.05)
    assert pool.waiting == 0
    pool.release()
    # The permit is still usable — the abandoned waiter did not swallow it.
    await asyncio.wait_for(pool.acquire(), timeout=0.5)


async def test_cancelled_waiter_passes_a_granted_permit_onward() -> None:
    """Cancellation racing a grant must not swallow the permit: the next waiter
    still gets it. Losing one here would shrink the pool for the process life."""
    pool = PermitPool(1)
    await pool.acquire()
    doomed = asyncio.create_task(pool.acquire())
    nxt = asyncio.create_task(pool.acquire())
    await asyncio.sleep(0)

    pool.release()  # hands the permit to `doomed`...
    doomed.cancel()  # ...which is cancelled in the same tick
    with pytest.raises(asyncio.CancelledError):
        await doomed
    await asyncio.wait_for(nxt, timeout=0.5)


async def test_release_never_exceeds_the_pool_size() -> None:
    pool = PermitPool(2)
    pool.release()
    pool.release()
    pool.release()
    assert pool.free == 2


async def test_pool_size_must_be_positive() -> None:
    with pytest.raises(ValueError, match="must be >= 1"):
        PermitPool(0)


async def test_lanes_are_per_client_and_standalone_is_a_real_key() -> None:
    lanes = LaneRegistry()
    a1, a2 = lanes.lane("A"), lanes.lane("A")
    assert a1 is a2  # same client -> same serial lane
    assert lanes.lane("B") is not a1
    # None is a first-class key (standalone), not "no lane".
    assert lanes.lane(None) is lanes.lane(None)
    assert lanes.lane(None) is not a1
    assert len(lanes) == 3


async def test_dropping_a_lane_forgets_it() -> None:
    """Broker clientIds are minted per connection, so a long-lived broker must
    not accumulate one lane per session it ever served."""
    lanes = LaneRegistry()
    lanes.lane("A")
    lanes.drop("A")
    assert len(lanes) == 0
    lanes.drop("A")  # idempotent
    assert len(lanes) == 0
