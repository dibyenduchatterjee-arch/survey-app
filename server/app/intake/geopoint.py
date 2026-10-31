"""The one geopoint parser. Intake, the OpenRosa endpoint and the CSV export all use it.

CANONICAL FORMAT (ODK's): a single string "lat lon [altitude [accuracy]]", space separated,
decimal numbers only. Rules, stated once:
    * latitude in [-90, 90], longitude in [-180, 180];
    * altitude, when present, is any finite number (it can be below sea level);
    * accuracy, when present, is a finite number >= 0 (it is a distance in metres, so a
      negative one is a corrupt value, not a reading);
    * 2 to 4 tokens; nan, inf, hex, underscores and anything else are refused.
Anything else raises GeopointError. Callers decide what a refusal means (a 422 on the way
in, a listed blank on the way out), but they never decide what is valid.
"""

import re
from dataclasses import dataclass

_DECIMAL = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_INF = float("inf")


class GeopointError(ValueError):
    """The value is not 'lat lon [altitude [accuracy]]'."""


@dataclass(frozen=True)
class Geopoint:
    lat: float
    lon: float
    altitude: float | None
    accuracy: float | None
    tokens: tuple[str, ...]  # the text as written, so an export can reproduce it exactly


def parse_geopoint(text: str) -> Geopoint:
    parts = text.split() if isinstance(text, str) else []
    if not 2 <= len(parts) <= 4 or not all(_DECIMAL.fullmatch(p) for p in parts):
        raise GeopointError("not 'lat lon [altitude [accuracy]]'")
    nums = [float(p) for p in parts]
    if any(abs(n) == _INF for n in nums):  # e.g. 1e999
        raise GeopointError("not 'lat lon [altitude [accuracy]]'")
    if not (-90 <= nums[0] <= 90 and -180 <= nums[1] <= 180):
        raise GeopointError("latitude or longitude out of range")
    if len(nums) == 4 and nums[3] < 0:
        raise GeopointError("negative accuracy")
    return Geopoint(
        lat=nums[0],
        lon=nums[1],
        altitude=nums[2] if len(nums) >= 3 else None,
        accuracy=nums[3] if len(nums) == 4 else None,
        tokens=tuple(parts),
    )
