"""LangChain callback handler that routes tool calls through KYA policy."""

from __future__ import annotations

import json
from typing import Any

from shield_kya import evaluate


def _tool_id(standardized_name: str, kwargs: dict) -> str:
    """Build a stable tool id from LangChain serialized input."""
    # Prefer an explicit server/tool split when provided.
    server = kwargs.get("metadata", {}).get("server")
    if server:
        return f"{server.strip()}__{standardized_name.strip()}"
    return standardized_name.strip()


class KyaLangChainCallbackHandler:
    """Base callback handler that evaluates tool calls with KYA before execution.

    Install with the langchain extra:
        pip install kya-langchain[langchain]

    Usage:
        from langchain_core.callbacks import BaseCallbackHandler
        from kya_langchain import KyaLangChainCallbackHandler

        handler = KyaLangChainCallbackHandler()
        agent.invoke(input, config={"callbacks": [handler]})
    """

    raise_on_deny = True
    offline = True

    def __init__(self, *, raise_on_deny: bool = True, offline: bool = True) -> None:
        self.raise_on_deny = raise_on_deny
        self.offline = offline

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: Any = None,
        parent_run_id: Any = None,
        **kwargs: Any,
    ) -> Any:
        """Evaluate the tool call before LangChain executes it."""
        tool_name = serialized.get("name") or serialized.get("kwargs", {}).get("name") or "unknown"
        try:
            args = json.loads(input_str) if isinstance(input_str, str) else dict(input_str)
        except (json.JSONDecodeError, TypeError, ValueError):
            args = {}

        result = evaluate(
            _tool_id(tool_name, kwargs),
            args=args,
        )
        response = (result.get("eval") or {}).get("response") or {}
        verdict = str(response.get("verdict", "")).upper()
        reason = str(response.get("reasonCode", ""))

        if verdict == "DENY" and self.raise_on_deny:
            from shield_kya import KyaDenied

            raise KyaDenied(tool_name, verdict, reason)

        # ALLOW and REQUIRE_APPROVE are recorded on the kya trail by the CLI.
        return None
