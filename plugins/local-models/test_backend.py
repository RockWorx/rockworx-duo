"""URL/base-resolution unit tests for the Local Models plugin backend.
Run: wsl -e bash -lc '~/.venvs/f16union/bin/python -m pytest <this dir> -q'"""
import os

import backend


def test_models_url():
    assert backend._models_url("http://localhost:11434") == "http://localhost:11434/v1/models"


def test_chat_url():
    assert backend._chat_url("http://localhost:1234") == "http://localhost:1234/v1/chat/completions"


def test_base_default_is_ollama():
    os.environ.pop("HARNESS_LOCAL_MODELS_URL", None)
    assert backend._base() == "http://localhost:11434"


def test_base_env_override_strips_trailing_slash():
    os.environ["HARNESS_LOCAL_MODELS_URL"] = "http://localhost:1234/"
    try:
        assert backend._base() == "http://localhost:1234"
    finally:
        os.environ.pop("HARNESS_LOCAL_MODELS_URL", None)
