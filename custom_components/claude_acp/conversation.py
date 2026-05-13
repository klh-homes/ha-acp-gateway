"""ConversationEntity backed by the ha-claude-acp gateway."""

from __future__ import annotations

import logging
from typing import Literal

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import (
    ClaudeAcpClient,
    ClaudeAcpConnectError,
    ClaudeAcpRemoteError,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Register one ConversationEntity per config entry."""
    client: ClaudeAcpClient = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([ClaudeAcpConversationEntity(entry, client)])


class ClaudeAcpConversationEntity(conversation.ConversationEntity):
    """Bridge HA's Assist pipeline to the ACP gateway."""

    _attr_has_entity_name = True
    _attr_supports_streaming = False

    def __init__(self, entry: ConfigEntry, client: ClaudeAcpClient) -> None:
        self._entry = entry
        self._client = client
        self._attr_unique_id = entry.entry_id
        self._attr_name = entry.title

    @property
    def supported_languages(self) -> Literal["*"] | list[str]:
        return "*"

    async def async_process(
        self,
        user_input: conversation.ConversationInput,
    ) -> conversation.ConversationResult:
        """Handle one user turn end-to-end."""
        conversation_id = user_input.conversation_id or "default"
        messages = [{"role": "user", "content": user_input.text}]

        intent_response = intent.IntentResponse(language=user_input.language)

        try:
            chunks: list[str] = []
            async for delta in self._client.converse(conversation_id, messages):
                chunks.append(delta)
            speech = "".join(chunks).strip()
        except ClaudeAcpRemoteError as err:
            _LOGGER.warning(
                "Gateway returned an error event: %s",
                err,
            )
            intent_response.async_set_speech(str(err))
            return conversation.ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
            )
        except ClaudeAcpConnectError as err:
            _LOGGER.error("Gateway connection failed: %s", err)
            intent_response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                "I can't reach the assistant right now.",
            )
            return conversation.ConversationResult(
                response=intent_response,
                conversation_id=conversation_id,
            )

        if not speech:
            speech = "I didn't get a reply."

        intent_response.async_set_speech(speech)
        return conversation.ConversationResult(
            response=intent_response,
            conversation_id=conversation_id,
            continue_conversation=_ends_with_question(speech),
        )


def _ends_with_question(speech: str) -> bool:
    """True if the reply ends with a question mark (ASCII or full-width).

    Used to decide whether HA's Assist pipeline should keep the satellite
    listening for a follow-up without another wake word. Claude is
    instructed via CLAUDE.md to end any reply that needs the user to
    respond with a question mark; statements get the conversation closed
    so the satellite returns to wake-word mode.
    """
    stripped = speech.rstrip()
    return stripped.endswith(("?", "？"))  # noqa: RUF001 — both forms are intentional
