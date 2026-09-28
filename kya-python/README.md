# shield-kya

In-process [kya](https://github.com/The-Pixel-Boys/shield-kya) (Know Your Agent) governance shim for Python agent frameworks.

`shield_kya` delegates policy evaluation to the local kya CLI (`kya wrap --offline --json ...`), so tools written for LangGraph, CrewAI, Pydantic AI, Google ADK, AutoGen, or smolagents all share the same offline verdict path as the TypeScript SDK. Stdlib only — no dependencies.

## Requirements

- Python ≥ 3.9
- The kya CLI on `PATH` (`npm i -g @shield-agent/kya`), or point `KYA_CLI` at the binary.

## Install

```sh
pip install shield-kya
```

## Usage

Evaluate a tool call without running it:

```python
import shield_kya

verdict = shield_kya.evaluate("org.sample.data.write", args={"table": "users"})
print(verdict["response"]["verdict"])  # ALLOW / DENY / REQUIRE_APPROVE
```

Govern a callable at the tool boundary — `DENY` raises `KyaDenied` before the function runs; `ALLOW` and observed `REQUIRE_APPROVE` proceed (and the verdict is recorded in the kya trail):

```python
from shield_kya import governed, KyaDenied

@governed("org.sample.data.write", irreversible=True)
def write_users_table(rows):
    ...

try:
    write_users_table(rows)
except KyaDenied as denied:
    print(denied.verdict, denied.reason_code)
```

## License

MIT
