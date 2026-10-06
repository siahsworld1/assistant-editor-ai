"""Structured, user-safe status for the AI steps of an analysis.

Every AI operation (transcription, visual analysis, selects, stories, the
Director's build) records what happened as a small dict the app can show
directly, instead of the outcome existing only as a server-side log line:

    {"task": "transcription", "status": "failed", "provider": "OpenAI",
     "category": "network", "message": "couldn't connect to OpenAI",
     "retryable": True, "httpStatus": None}

status:   "succeeded" | "failed" | "not-applicable"
category: "not-configured" | "network" | "timeout" | "auth" | "rate-limit"
          | "provider-error" | "bad-request" | "unknown"

Classification uses only the exception's TYPE and HTTP status code — never its
message, which for the vendor SDKs can echo the provider's response body.
Nothing here ever sees, stores or returns an API key.
"""

from __future__ import annotations

TASKS = ("transcription", "visual-analysis", "selects", "stories")
TASK_LABELS = {
    "transcription": "Transcription",
    "visual-analysis": "Visual analysis",
    "selects": "Select ranking",
    "stories": "Story generation",
    "director": "The Director",
}

# Phrased to follow a task name: "transcription couldn't connect to OpenAI".
_MESSAGES = {
    "not-configured": "needs an {p} API key — add it in Settings",
    "network": "couldn't connect to {p}",
    "timeout": "timed out waiting for {p}",
    "auth": "was rejected by {p} — check the API key in Settings",
    "rate-limit": "was rate-limited by {p}",
    "provider-error": "got a provider error from {p}",
    "bad-request": "was rejected by {p} as an invalid request",
    "unknown": "didn't complete ({p})",
}
# Worth retrying as-is (transient). Key problems need Settings first.
_RETRYABLE = {"network", "timeout", "rate-limit", "provider-error", "unknown"}


def provider_label(provider_name: str | None, fallback: str = "the AI provider") -> str:
    """'openai-whisper' -> 'OpenAI', 'anthropic-claude' -> 'Anthropic'."""
    name = (provider_name or "").lower()
    if name.startswith("openai"):
        return "OpenAI"
    if name.startswith("anthropic"):
        return "Anthropic"
    return provider_name or fallback


def _type_names(exc: BaseException) -> set[str]:
    return {cls.__name__ for cls in type(exc).__mro__}


def _http_status(exc: BaseException) -> int | None:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def classify(exc: BaseException) -> tuple[str, int | None]:
    """(category, http status or None) for an exception from a provider call."""
    names = _type_names(exc)
    status = _http_status(exc)
    if "ProviderError" in names:
        # Raised by providers/*._client() when the key is missing (the only
        # place ProviderError is raised outside the registry).
        return "not-configured", None
    if names & {"APITimeoutError", "TimeoutException", "ReadTimeout", "ConnectTimeout", "TimeoutError"}:
        return "timeout", status
    if names & {"APIConnectionError", "ConnectError", "NetworkError", "TransportError", "ConnectionError"}:
        return "network", status
    if status is not None:
        if status in (401, 403):
            return "auth", status
        if status == 429:
            return "rate-limit", status
        if status >= 500:
            return "provider-error", status
        if 400 <= status < 500:
            return "bad-request", status
    if names & {"AuthenticationError", "PermissionDeniedError"}:
        return "auth", status
    if "RateLimitError" in names:
        return "rate-limit", status
    if names & {"InternalServerError", "OverloadedError", "ServiceUnavailableError"}:
        return "provider-error", status
    return "unknown", status


def succeeded(task: str, provider: str | None) -> dict:
    return {"task": task, "status": "succeeded", "provider": provider}


def not_applicable(task: str, reason: str) -> dict:
    return {"task": task, "status": "not-applicable", "reason": reason}


def failed(task: str, provider: str, exc: BaseException) -> dict:
    category, status = classify(exc)
    message = _MESSAGES[category].format(p=provider)
    if status is not None and category in {"provider-error", "bad-request"}:
        message += f" (HTTP {status})"
    return {
        "task": task,
        "status": "failed",
        "provider": provider,
        "category": category,
        "message": message,
        "retryable": category in _RETRYABLE,
        "httpStatus": status,
    }


def log_line(entry: dict) -> str:
    """What the worker log records for a failure — category and status only."""
    status = f" HTTP {entry['httpStatus']}" if entry.get("httpStatus") else ""
    return f"{entry['task']} failed ({entry['provider']}: {entry['category']}{status})"


def outcome(entries: list[dict]) -> str:
    """'succeeded' | 'partial' | 'failed' over the AI tasks that applied."""
    applicable = [e for e in entries if e.get("status") in {"succeeded", "failed"}]
    if not applicable:
        return "succeeded"
    failures = sum(1 for e in applicable if e["status"] == "failed")
    if failures == 0:
        return "succeeded"
    if failures == len(applicable):
        return "failed"
    return "partial"


def headline(result: str, issues: list[dict]) -> str | None:
    """One concise sentence for the app, e.g.
    'AI analysis incomplete — transcription couldn't connect to OpenAI.'"""
    if result == "succeeded" or not issues:
        return None
    first = issues[0]
    lead = "AI analysis failed" if result == "failed" else "AI analysis incomplete"
    task = TASK_LABELS.get(first["task"], first["task"]).lower()
    return f"{lead} — {task} {first['message']}."
