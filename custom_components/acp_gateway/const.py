"""Constants for the ACP Gateway integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "acp_gateway"

CONF_NAME: Final = "name"
CONF_GATEWAY_URL: Final = "gateway_url"
CONF_BEARER_TOKEN: Final = "bearer_token"
CONF_MAX_TOKENS: Final = "max_tokens"
CONF_REQUEST_TIMEOUT_S: Final = "request_timeout_s"

DEFAULT_MAX_TOKENS: Final = 300
DEFAULT_REQUEST_TIMEOUT_S: Final = 30
