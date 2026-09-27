"""In-process kya governance shim for Python agent frameworks.

Delegates evaluation to the local kya CLI (`kya wrap --offline --json ...`),
so LangGraph, CrewAI, Pydantic AI, Google ADK, AutoGen, and smolagents tools
all share the same offline verdict path as the TypeScript SDK. Stdlib only.
"""

from __future__ import annotations

import functools
import inspect
import json
import os
import shutil
import subprocess

__version__ = "0.13.0"
__all__ = ["KyaDenied", "evaluate", "governed"]

_CLI_TIMEOUT_S = 60


class KyaDenied(Exception):
    """Raised when kya denies a tool call; the wrapped function never ran."""

    def __init__(self, tool_id: str, verdict: str, reason_code: str) -> None:
        super().__init__(f"kya {verdict}: {tool_id} ({reason_code or 'no reason'})")
        self.tool_id = tool_id
        self.verdict = verdict
        self.reason_code = reason_code


def _run_kya(argv: list[str]) -> dict:
    exe = shutil.which(os.environ.get("KYA_CLI", "kya"))
    if exe is None:
        raise RuntimeError(
            "kya CLI not found on PATH — install @shield-agent/kya "
            "(npm i -g @shield-agent/kya) or set KYA_CLI"
        )
    env = {**os.environ, "KYA_SKIP_NODE_CHECK": "1"}
    proc = subprocess.run(
        [exe, *argv],
        capture_output=True,
        text=True,
        timeout=_CLI_TIMEOUT_S,
        env=env,
    )
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"kya returned non-JSON output (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:200] or proc.stdout[:200]}"
        ) from exc
    # 0=allow, 1=deny, 4=hold — anything else is a transport/infra failure,
    # not a policy verdict.
    if proc.returncode not in (0, 1, 4):
        raise RuntimeError(
            f"kya exited {proc.returncode} (transport failure, not a verdict): "
            f"{proc.stderr.strip()[:200]}"
        )
    return data


def _json_safe(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def _bound_args_json(fn, args, kwargs) -> str:
    """Bound call arguments as JSON for `kya wrap --args`; never raises."""
    try:
        bound = inspect.signature(fn).bind(*args, **kwargs)
        projected = {k: _json_safe(v) for k, v in bound.arguments.items()}
    except (TypeError, ValueError):
        projected = {}
    return json.dumps(projected)


def _full_tool_id(tool_id: str, server: str | None) -> str:
    return f"{server.strip()}__{tool_id.strip()}" if server else tool_id.strip()


def evaluate(tool_id: str, args: dict | None = None) -> dict:
    """Evaluate a tool call offline; returns the parsed eval-tool JSON dict."""
    argv = [
        "eval-tool",
        "--offline",
        "--json",
        "--tool-id",
        tool_id,
        "--args",
        json.dumps(args or {}),
    ]
    return _run_kya(argv)


def governed(tool_id: str, server: str | None = None, irreversible: bool = False):
    """Decorator: govern the wrapped callable at the tool boundary.

    ALLOW and observed REQUIRE_APPROVE run the function; DENY raises
    KyaDenied without calling it. The verdict comes from
    `kya wrap --offline --json`, which also records the trail event.
    """
    full_id = _full_tool_id(tool_id, server)

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            argv = [
                "wrap",
                "--offline",
                "--json",
                "--tool-id",
                full_id,
                "--args",
                _bound_args_json(fn, args, kwargs),
            ]
            if irreversible:
                argv.append("--irreversible")
            result = _run_kya(argv)
            response = (result.get("eval") or {}).get("response") or {}
            verdict = str(response.get("verdict", "")).upper() or "DENY"
            if verdict not in ("ALLOW", "REQUIRE_APPROVE"):
                raise KyaDenied(full_id, verdict, str(response.get("reasonCode", "")))
            return fn(*args, **kwargs)

        return wrapper

    return decorator
