"""Constants for the Claude Agent (ACP) integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "claude_acp"

CONF_GATEWAY_URL: Final = "gateway_url"
CONF_BEARER_TOKEN: Final = "bearer_token"
CONF_MODEL: Final = "model"
CONF_SYSTEM_PROMPT: Final = "system_prompt"
CONF_MAX_TOKENS: Final = "max_tokens"
CONF_REQUEST_TIMEOUT_S: Final = "request_timeout_s"

DEFAULT_MODEL: Final = "claude-sonnet-4-6"
DEFAULT_MAX_TOKENS: Final = 300
DEFAULT_REQUEST_TIMEOUT_S: Final = 30

MODELS: Final = (
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-7",
)
