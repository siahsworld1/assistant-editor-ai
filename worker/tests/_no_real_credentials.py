"""Guarantees the automated test suite can never reach a real, paid AI provider.

Every test module imports this first. On import it:

- removes OPENAI_API_KEY / ANTHROPIC_API_KEY from this process's environment
  (in case they're exported in the developer's shell), and
- sets ASSISTANT_EDITOR_SKIP_DOTENV=1, which makes server.py skip load_dotenv()
  — otherwise importing server.py (directly, or via validate_e2e.py) finds the
  repo-root .env and puts the real keys straight back.

Subprocesses inherit os.environ, so a worker or validator started by a test is
covered too. With no key present, every provider's _client() raises
ProviderError (see providers/*_provider.py) before any SDK client is created or
any network call is made.
"""

from __future__ import annotations

import os

CREDENTIAL_ENV_VARS = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY")

for _name in CREDENTIAL_ENV_VARS:
    os.environ.pop(_name, None)
os.environ["ASSISTANT_EDITOR_SKIP_DOTENV"] = "1"
