"""Tests for kya_langchain callback handler."""

import json
from unittest import mock

import pytest

from kya_langchain import KyaLangChainCallbackHandler
from shield_kya import KyaDenied


@mock.patch("kya_langchain.callback.evaluate")
def test_on_tool_start_allow_does_not_raise(mock_eval):
    mock_eval.return_value = {"eval": {"response": {"verdict": "ALLOW", "reasonCode": ""}}}
    handler = KyaLangChainCallbackHandler()
    handler.on_tool_start({"name": "write_file"}, json.dumps({"path": "x.txt"}))
    mock_eval.assert_called_once()


@mock.patch("kya_langchain.callback.evaluate")
def test_on_tool_start_deny_raises(mock_eval):
    mock_eval.return_value = {"eval": {"response": {"verdict": "DENY", "reasonCode": "NEVER_EVENT"}}}
    handler = KyaLangChainCallbackHandler()
    with pytest.raises(KyaDenied):
        handler.on_tool_start({"name": "delete_all"}, "{}")


@mock.patch("kya_langchain.callback.evaluate")
def test_on_tool_start_require_approve_allows(mock_eval):
    mock_eval.return_value = {
        "eval": {"response": {"verdict": "REQUIRE_APPROVE", "reasonCode": "HIGH_STAKES_WRITE"}}
    }
    handler = KyaLangChainCallbackHandler()
    handler.on_tool_start({"name": "write_file"}, "{}")
