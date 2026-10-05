"""Tests for kya_crewai step hook."""

from unittest import mock

import pytest

from kya_crewai import KyaCrewaiStepHook
from shield_kya import KyaDenied


@mock.patch("kya_crewai.hook.evaluate")
def test_step_allow(mock_eval):
    mock_eval.return_value = {"eval": {"response": {"verdict": "ALLOW", "reasonCode": ""}}}
    hook = KyaCrewaiStepHook()
    hook({"tool": "write_file", "tool_input": {"path": "x.txt"}})
    mock_eval.assert_called_once_with("write_file", args={"path": "x.txt"})


@mock.patch("kya_crewai.hook.evaluate")
def test_step_deny(mock_eval):
    mock_eval.return_value = {"eval": {"response": {"verdict": "DENY", "reasonCode": "NEVER_EVENT"}}}
    hook = KyaCrewaiStepHook()
    with pytest.raises(KyaDenied):
        hook({"tool": "delete_all", "tool_input": {}})


@mock.patch("kya_crewai.hook.evaluate")
def test_step_no_tool_skips(mock_eval):
    hook = KyaCrewaiStepHook()
    hook({"thought": "no tool here"})
    mock_eval.assert_not_called()
