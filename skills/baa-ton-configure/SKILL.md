---
name: baa-ton-configure
description: Edit a Baa-ton project's explicit scope, profile, and approval ask-list choices.
---

Read the recorded runtime README and config. Preserve existing scopes/profiles and unrelated settings. Scopes pin endpoint/workspace/cwd; use a new scope name when those bindings change. Profiles name exact harness, model, effort, and existing authentication. Honor the user's model preference without changing global model defaults or other users' defaults.

`approvals.ask` contains exact MCP tool names, never wildcards or natural-language grants. Explain any changed powers and regenerate the Codex host snippet after an ask-list change. It needs a client reconnect and an approved persistent config update. Provider rules, native shell permissions, and external-operation checks still apply. Do not turn a missing field into permission to select an account or model.
