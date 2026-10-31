"""In-process fixed-window rate limiter.

State lives in this process's memory. That is deliberate and sufficient for a
single-process deployment; it does not span worker processes, so a multi-worker
deployment needs a shared store (known Phase 2 item).

Memory is bounded by `max_keys`: once full, the oldest windows are evicted, so under a
flood of distinct keys the limiter forgets its oldest counters rather than growing.

Time enters as a `clock` parameter (seconds, monotonic) so tests need no sleeping.
"""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable

DEFAULT_MAX_KEYS = 50_000


class RateLimited(Exception):
    """The key has used up its attempts for the current window."""

    def __init__(self, retry_after: int) -> None:
        super().__init__("rate limited")
        self.retry_after = retry_after


class RateLimiter:
    def __init__(
        self,
        limit: int,
        window_seconds: int,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = DEFAULT_MAX_KEYS,
    ) -> None:
        if limit < 1 or window_seconds < 1 or max_keys < 1:
            raise ValueError("limit, window_seconds and max_keys must be at least 1")
        self.limit = limit
        self.window_seconds = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self.max_keys = max_keys
        # key -> (window start, count), kept in window-start order (oldest first) so
        # expired and, under a flood, oldest windows are evicted from the front in O(1).
        self._windows: OrderedDict[str, tuple[float, int]] = OrderedDict()

    def check(self, key: str) -> None:
        """Count one attempt for `key`; raise RateLimited if it exceeds the limit.

        Attempts past the limit are rejected without extending the window.
        """
        now = self._clock()
        with self._lock:
            while self._windows:  # drop expired windows from the front
                oldest = next(iter(self._windows.values()))
                if now - oldest[0] < self.window_seconds:
                    break
                self._windows.popitem(last=False)
            entry = self._windows.get(key)
            if entry is None:
                # Hard cap on memory: when full, evict the oldest windows (a flood of
                # distinct keys cannot grow the table or slow every call down).
                while len(self._windows) >= self.max_keys:
                    self._windows.popitem(last=False)
                self._windows[key] = (now, 1)
                return
            start, count = entry
            if count >= self.limit:
                raise RateLimited(retry_after=max(1, int(start + self.window_seconds - now) + 1))
            self._windows[key] = (start, count + 1)

    def refund(self, key: str) -> None:
        """Take back one counted attempt (never below zero); the window is unchanged.

        For attempts that turn out not to count, e.g. a login that succeeds.
        """
        with self._lock:
            entry = self._windows.get(key)
            if entry is not None and entry[1] > 0:
                self._windows[key] = (entry[0], entry[1] - 1)

    def reset(self, key: str) -> None:
        with self._lock:
            self._windows.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._windows.clear()
