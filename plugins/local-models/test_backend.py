"""URL/base-resolution unit tests for the Local Models plugin backend.
Run: pytest test_backend.py -q   (from this directory)"""
import os

import backend


def test_models_url():
    assert backend._models_url("http://localhost:11434") == "http://localhost:11434/v1/models"


def test_chat_url():
    assert backend._chat_url("http://localhost:1234") == "http://localhost:1234/v1/chat/completions"


def test_default_bases_cover_ollama_and_lmstudio():
    os.environ.pop("HARNESS_LOCAL_MODELS_URL", None)
    bases = backend._candidate_bases()
    assert "http://localhost:11434" in bases   # Ollama
    assert "http://localhost:1234" in bases     # LM Studio


def test_env_override_wins_and_strips_slash():
    os.environ["HARNESS_LOCAL_MODELS_URL"] = "http://localhost:9999/"
    try:
        assert backend._candidate_bases() == ["http://localhost:9999"]
    finally:
        os.environ.pop("HARNESS_LOCAL_MODELS_URL", None)
