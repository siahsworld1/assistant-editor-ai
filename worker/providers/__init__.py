"""Vendor-swappable AI provider interfaces for Assistant Editor AI.

Nothing outside this package should import an AI vendor SDK (openai, anthropic)
directly. worker/reasoning.py (the editorial-reasoning architecture) and
worker/pipeline.py (footage-analysis orchestration) talk only to the
TranscriptionProvider / ReasoningProvider interfaces in providers.base, obtained
either from providers.registry (production, env-var-selected) or injected
directly (tests — see worker/tests/fakes.py).
"""
