"""Config flow for Claude Agent (ACP)."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import (
    CONF_BEARER_TOKEN,
    CONF_GATEWAY_URL,
    CONF_NAME,
    CONF_REQUEST_TIMEOUT_S,
    DEFAULT_REQUEST_TIMEOUT_S,
    DOMAIN,
)
from .coordinator import ClaudeAcpClient, ClaudeAcpConnectError

_LOGGER = logging.getLogger(__name__)

USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_NAME): str,
        vol.Required(CONF_GATEWAY_URL): str,
        vol.Required(CONF_BEARER_TOKEN): str,
        vol.Optional(
            CONF_REQUEST_TIMEOUT_S,
            default=DEFAULT_REQUEST_TIMEOUT_S,
        ): vol.All(int, vol.Range(min=1, max=300)),
    }
)


class ClaudeAcpConfigFlow(ConfigFlow, domain=DOMAIN):
    """Each config entry is one Claude persona deployment."""

    VERSION = 1

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            client = ClaudeAcpClient(
                self.hass,
                user_input[CONF_GATEWAY_URL],
                user_input[CONF_BEARER_TOKEN],
                user_input.get(CONF_REQUEST_TIMEOUT_S, DEFAULT_REQUEST_TIMEOUT_S),
            )
            try:
                await client.healthcheck()
            except ClaudeAcpConnectError as err:
                _LOGGER.warning("Healthcheck failed during config: %s", err)
                errors["base"] = "cannot_connect"

            if not errors:
                unique_id = f"{user_input[CONF_NAME]}::{user_input[CONF_GATEWAY_URL]}"
                await self.async_set_unique_id(unique_id)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=user_input[CONF_NAME],
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=USER_SCHEMA,
            errors=errors,
        )
