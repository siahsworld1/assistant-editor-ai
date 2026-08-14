"""JSON extraction from raw model text output. Shared by every provider's caller
(worker/reasoning.py) since models of every vendor occasionally wrap JSON in
prose or markdown code fences — this is a parsing concern, not a vendor concern,
so it lives outside any one provider implementation.
"""

from __future__ import annotations

import json
import re


def extract_json(text: str):
    """Pulls the first balanced {...} or [...] out of a model response, tolerating
    prose or markdown fences around it. Returns None (never raises) on failure —
    callers treat a parse failure as "no results", not a crash."""
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    start_chars = "{["
    for i, ch in enumerate(text):
        if ch in start_chars:
            depth = 0
            opener = ch
            closer = "}" if opener == "{" else "]"
            for j in range(i, len(text)):
                if text[j] == opener:
                    depth += 1
                elif text[j] == closer:
                    depth -= 1
                    if depth == 0:
                        candidate = text[i : j + 1]
                        try:
                            return json.loads(candidate)
                        except json.JSONDecodeError:
                            break
            break
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
