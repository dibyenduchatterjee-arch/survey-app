"""The caller's network address, shared by the login rate limiter and the audit log."""

import ipaddress
import logging

from fastapi import Request

from app.core.config import Settings

logger = logging.getLogger(__name__)
_warned_unconfigured_proxy = False


def _warn_if_unconfigured_proxy(peer: str) -> None:
    """Once per process: a private or loopback peer with trust off usually means a proxy."""
    global _warned_unconfigured_proxy
    if _warned_unconfigured_proxy:
        return
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return
    if addr.is_private or addr.is_loopback:
        _warned_unconfigured_proxy = True
        logger.warning(
            "Requests are arriving from a private or loopback address while "
            "TRUST_PROXY_HEADERS is off. If a reverse proxy (Caddy, nginx) sits in front, "
            "every client is sharing one login rate-limit bucket. Set TRUST_PROXY_HEADERS=true "
            "(and TRUSTED_PROXY_HOPS if more than one proxy) in the environment."
        )


def client_ip(request: Request, settings: Settings) -> str:
    """The caller's address, for rate limiting.

    Behind a trusted proxy the peer address is the proxy, so with
    trust_proxy_headers on we read X-Forwarded-For from the right-hand end:
    `trusted_proxy_hops` entries in. The left-most entries are whatever the client
    chose to send and are never used. Anything unusable falls back to the peer.
    """
    peer = request.client.host if request.client else "unknown"
    if not settings.trust_proxy_headers:
        _warn_if_unconfigured_proxy(peer)
        return peer
    # A proxy may add its entry as a separate header line (HAProxy forwardfor), so
    # read every line, in order, as one list; get() would return only the first line.
    header = ",".join(request.headers.getlist("x-forwarded-for"))
    if not header:
        return peer
    parts = [p.strip() for p in header.split(",")]
    if len(parts) < settings.trusted_proxy_hops:
        return peer
    candidate = parts[-settings.trusted_proxy_hops]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return peer
