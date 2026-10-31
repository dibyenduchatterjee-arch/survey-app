"""In-process fixed-window rate limiter.

State lives in this process's memory. That is deliberate and sufficient for a
single-process deployment; it does not span worker processes, so a multi-worker
deployment needs a shared store (known Phase 2 item).

Time enters as a `clock` parameter (seconds, monotonic) so tests need no sleeping.
"""

import threading
import time
from collections.abc import Callable

_PRUNE_ABOVE = 10_000  # entries; expired windows are dropped once the table is this big


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
    ) -> None:
        if limit < 1 or window_seconds < 1:
            raise ValueError("limit and window_seconds must be at least 1")
        self.limit = limit
        self.window_seconds = window_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._windows: dict[str, tuple[float, int]] = {}  # key -> (window start, count)

    def check(self, key: str) -> None:
        """Count one attempt for `key`; raise RateLimited if it exceeds the limit.

        Attempts past the limit are rejected without extending the window.
        """
        now = self._clock()
        with self._lock:
            if len(self._windows) > _PRUNE_ABOVE:
                self._windows = {
                    k: v for k, v in self._windows.items() if now - v[0] < self.window_seconds
                }
            start, count = self._windows.get(key, (now, 0))
            if now - start >= self.window_seconds:
                start, count = now, 0
            if count >= self.limit:
                raise RateLimited(retry_after=max(1, int(start + self.window_seconds - now) + 1))
            self._windows[key] = (start, count + 1)

    def reset(self, key: str) -> None:
        with self._lock:
            self._windows.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._windows.clear()
