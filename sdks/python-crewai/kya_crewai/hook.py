"""CrewAI step hook that routes tool calls through KYA policy."""

from __future__ import annotations

from typing import Any

from shield_kya import evaluate


def _extract_tool_call(step: Any) -> tuple[str, dict] | None:
    """Try to extract tool name and args from a CrewAI step dict."""
    if not isinstance(step, dict):
        return None
    # Common CrewAI step shapes
    tool = step.get("tool") or step.get("tool_name") or step.get("action", {}).get("tool")
    args = step.get("tool_input") or step.get("input") or step.get("action", {}).get("tool_input") or {}
    if not tool:
        return None
    if not isinstance(args, dict):
        args = {"input": args}
    return str(tool), args


class KyaCrewaiStepHook:
    """Step callback that evaluates tool calls with KYA before execution.

    Install with the crewai extra:
        pip install kya-crewai[crewai]

    Usage:
        from crewai import Crew, Agent, Task
        from kya_crewai import KyaCrewaiStepHook

        hook = KyaCrewaiStepHook()
        crew = Crew(agents=[...], tasks=[...], step_callback=hook)
        crew.kickoff()
    """

    raise_on_deny = True
    offline = True

    def __init__(self, *, raise_on_deny: bool = True, offline: bool = True) -> None:
        self.raise_on_deny = raise_on_deny
        self.offline = offline

    def __call__(self, step: Any) -> None:
        """Evaluate a tool call inside a CrewAI step."""
        extracted = _extract_tool_call(step)
        if extracted is None:
            return
        tool_id, args = extracted
        result = evaluate(tool_id, args=args)
        response = (result.get("eval") or {}).get("response") or {}
        verdict = str(response.get("verdict", "")).upper()
        reason = str(response.get("reasonCode", ""))

        if verdict == "DENY" and self.raise_on_deny:
            from shield_kya import KyaDenied

            raise KyaDenied(tool_id, verdict, reason)

        # ALLOW and REQUIRE_APPROVE are recorded on the kya trail by the CLI.
