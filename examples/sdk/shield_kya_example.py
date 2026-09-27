# Python shim: govern any framework's tool boundary via the kya CLI.
# Requires the kya CLI on PATH (npm i -g @shield-agent/kya).
# Run: python3 examples/sdk/shield_kya_example.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "kya-python"))

from shield_kya import KyaDenied, governed


@governed("org.sample.safe.read")
def read_record(record_id: str) -> dict:
    return {"id": record_id, "found": True}


@governed("org.sample.never.event")
def dangerous() -> str:
    return "this never runs"


print(read_record("rec-1"))

try:
    dangerous()
except KyaDenied as denied:
    print(f"blocked: {denied.tool_id} ({denied.reason_code})")
