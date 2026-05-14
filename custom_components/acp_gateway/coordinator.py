"""HTTP client that talks to the ha-acp-gateway service service."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

_LOGGER = logging.getLogger(__name__)


class AcpGatewayError(Exception):
    """Base error for gateway interactions."""


class AcpGatewayConnectError(AcpGatewayError):
    """The gateway could not be reached or healthz failed."""


class AcpGatewayRemoteError(AcpGatewayError):
    """The gateway returned an SSE `error` event (TTS-readable message)."""


class AcpGatewayClient:
    """Thin async client for POST /v1/converse + SSE parsing."""

    def __init__(
        self,
        hass: HomeAssistant,
        gateway_url: str,
        bearer_token: str,
        timeout_s: int,
    ) -> None:
        self._hass = hass
        self._gateway_url = gateway_url.rstrip("/")
        self._bearer_token = bearer_token
        self._timeout_s = timeout_s

    async def healthcheck(self) -> None:
        """Hit /healthz; raise AcpGatewayConnectError on any failure."""
        session = async_get_clientsession(self._hass)
        try:
            async with session.get(
                f"{self._gateway_url}/healthz",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    raise AcpGatewayConnectError(f"healthz returned HTTP {resp.status}")
        except (TimeoutError, aiohttp.ClientError) as err:
            raise AcpGatewayConnectError(str(err)) from err

    async def converse(
        self,
        conversation_id: str,
        messages: list[dict[str, str]],
    ) -> AsyncIterator[str]:
        """POST /v1/converse and yield text deltas from the SSE stream.

        Raises AcpGatewayConnectError on transport-level problems and
        AcpGatewayRemoteError on a server-emitted `error` event.
        """
        session = async_get_clientsession(self._hass)
        url = f"{self._gateway_url}/v1/converse"
        body = {"conversation_id": conversation_id, "messages": messages}
        headers = {
            "Authorization": f"Bearer {self._bearer_token}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        try:
            async with session.post(
                url,
                json=body,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=self._timeout_s),
            ) as resp:
                if resp.status == 401:
                    raise AcpGatewayConnectError("gateway rejected bearer token (401)")
                if resp.status >= 400:
                    text = await resp.text()
                    raise AcpGatewayConnectError(
                        f"gateway HTTP {resp.status}: {text[:200]}"
                    )

                async for event, data in _parse_sse(resp.content):
                    if event == "text":
                        delta = data.get("delta")
                        if isinstance(delta, str) and delta:
                            yield delta
                    elif event == "done":
                        return
                    elif event == "error":
                        message = data.get("message") or "Unknown error"
                        raise AcpGatewayRemoteError(message)
                    else:
                        _LOGGER.debug("ignoring SSE event: %s", event)
        except aiohttp.ClientError as err:
            raise AcpGatewayConnectError(str(err)) from err
        except TimeoutError as err:
            raise AcpGatewayConnectError("gateway timed out") from err


async def _parse_sse(
    stream: aiohttp.StreamReader,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Yield (event, parsed_data) pairs from a server-sent-events stream."""
    event: str | None = None
    data_buf: list[str] = []
    async for raw in stream:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":
            if event is not None:
                payload = "".join(data_buf)
                try:
                    parsed: dict[str, Any] = json.loads(payload) if payload else {}
                except json.JSONDecodeError:
                    _LOGGER.warning("SSE data is not valid JSON: %r", payload)
                    parsed = {}
                yield event, parsed
            event = None
            data_buf = []
            continue
        if line.startswith(":"):
            continue  # comment line
        if line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            data_buf.append(line[len("data:") :].lstrip())
