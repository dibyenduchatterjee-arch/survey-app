import pytest

from app.core.ratelimit import RateLimited, RateLimiter


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_allows_up_to_the_limit_then_raises():
    rl = RateLimiter(3, 60, clock=Clock())
    for _ in range(3):
        rl.check("k")
    with pytest.raises(RateLimited):
        rl.check("k")


def test_keys_are_independent():
    rl = RateLimiter(1, 60, clock=Clock())
    rl.check("a")
    with pytest.raises(RateLimited):
        rl.check("a")
    rl.check("b")


def test_window_expiry_resets_the_count():
    clock = Clock()
    rl = RateLimiter(1, 60, clock=clock)
    rl.check("k")
    clock.t += 59
    with pytest.raises(RateLimited):
        rl.check("k")
    clock.t += 1
    rl.check("k")


def test_rejected_attempts_do_not_extend_the_window():
    clock = Clock()
    rl = RateLimiter(1, 60, clock=clock)
    rl.check("k")
    for _ in range(5):
        clock.t += 10
        with pytest.raises(RateLimited):
            rl.check("k")
    clock.t += 10  # 60s after the first attempt
    rl.check("k")


def test_retry_after_reports_the_remaining_window():
    clock = Clock()
    rl = RateLimiter(1, 60, clock=clock)
    rl.check("k")
    clock.t += 20
    with pytest.raises(RateLimited) as exc:
        rl.check("k")
    assert 40 <= exc.value.retry_after <= 41


def test_reset_and_clear():
    rl = RateLimiter(1, 60, clock=Clock())
    rl.check("a")
    rl.check("b")
    rl.reset("a")
    rl.check("a")
    rl.clear()
    rl.check("b")


def test_rejects_nonsense_configuration():
    with pytest.raises(ValueError):
        RateLimiter(0, 60)
    with pytest.raises(ValueError):
        RateLimiter(5, 0)
    with pytest.raises(ValueError):
        RateLimiter(5, 60, max_keys=0)


def test_refund_gives_back_one_attempt_and_never_goes_negative():
    rl = RateLimiter(2, 60, clock=Clock())
    rl.check("k")
    rl.check("k")
    rl.refund("k")
    rl.check("k")
    with pytest.raises(RateLimited):
        rl.check("k")
    rl.refund("unknown")  # no-op
    rl.clear()
    rl.refund("k")
    rl.check("k")
    rl.check("k")
    with pytest.raises(RateLimited):
        rl.check("k")


def test_table_size_is_capped_by_evicting_the_oldest_windows():
    clock = Clock()
    rl = RateLimiter(1, 600, clock=clock, max_keys=3)
    for k in "abc":
        rl.check(k)
        clock.t += 1
    rl.check("d")  # table full: "a", the oldest, is evicted
    assert len(rl._windows) == 3
    rl.check("a")  # forgotten, so allowed again
    with pytest.raises(RateLimited):
        rl.check("c")  # newer windows survived
    for i in range(1000):  # a flood of distinct keys never grows the table
        rl.check(f"flood{i}")
    assert len(rl._windows) <= 3


def test_expired_windows_are_dropped_from_the_table():
    clock = Clock()
    rl = RateLimiter(1, 60, clock=clock, max_keys=100)
    for i in range(10):
        rl.check(f"k{i}")
    clock.t += 61
    rl.check("fresh")
    assert list(rl._windows) == ["fresh"]
