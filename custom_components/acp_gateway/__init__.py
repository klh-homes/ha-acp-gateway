"""ACP Gateway integration for Home Assistant."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import (
    CONF_BEARER_TOKEN,
    CONF_GATEWAY_URL,
    CONF_REQUEST_TIMEOUT_S,
    DEFAULT_REQUEST_TIMEOUT_S,
    DOMAIN,
)
from .coordinator import AcpGatewayClient

__all__ = ["DOMAIN", "async_setup_entry", "async_unload_entry"]

PLATFORMS: list[Platform] = [Platform.CONVERSATION]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one persona from a config entry."""
    client = AcpGatewayClient(
        hass,
        entry.data[CONF_GATEWAY_URL],
        entry.data[CONF_BEARER_TOKEN],
        entry.data.get(CONF_REQUEST_TIMEOUT_S, DEFAULT_REQUEST_TIMEOUT_S),
    )
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = client

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a persona."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return unloaded
