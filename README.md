# OpenObserve Codex Observability Plugin

Export OpenAI Codex sessions to OpenObserve as OpenTelemetry traces. After each completed turn,
the plugin reads the local Codex rollout transcript and reconstructs:

- User prompts and assistant responses
- Model generations and token usage
- Tool calls, arguments, results, and errors
- Reasoning summaries when explicitly enabled
- Child-agent turns and their tools
- Session, thread, and turn relationships

The exporter fails open by default, so an unavailable observability backend does not stop a Codex
turn. Successfully exported turns are recorded in plugin-owned state to prevent duplicates when a
session resumes or a hook is retried.

## Requirements

- OpenAI Codex 0.145 or newer with lifecycle hooks
- Node.js 20 or newer available as `node`
- An OpenObserve endpoint and an ingestion credential

## Install

Add this repository as a Codex marketplace and install the plugin:

```bash
codex plugin marketplace add https://github.com/openobserve/openobserve-codex-observability-plugin.git
codex plugin add openobserve@openobserve-codex
```

For local development from a repository checkout:

```bash
codex plugin marketplace add .
codex plugin add openobserve@openobserve-codex
```

Install **OpenObserve Tracing** from the Codex or ChatGPT Desktop plugin directory. If needed, enable
it explicitly in `~/.codex/config.toml`:

```toml
[plugins."openobserve@openobserve-codex"]
enabled = true
```

Restart Codex Desktop after installation. Open `/hooks` in Codex, review the plugin's command hook,
and trust it. Codex does not run newly installed plugin hooks before this review.

## Configure

Create `~/.codex/openobserve.json`:

```json
{
  "enabled": true,
  "endpoint": "https://openobserve.example.com",
  "organization": "default",
  "stream_name": "codex",
  "authorization": "Basic REPLACE_WITH_BASE64_USER_AND_PASSWORD",
  "capture_content": true,
  "capture_reasoning": false,
  "capture_tool_content": true,
  "max_chars": 20000,
  "environment": "development",
  "service_name": "codex"
}
```

On macOS and Linux, restrict access to credential-bearing configuration:

```bash
chmod 600 ~/.codex/openobserve.json
```

`endpoint` accepts either an OpenObserve base URL or the full OTLP traces URL:

```text
https://openobserve.example.com/api/default/v1/traces
```

The plugin sends OTLP/HTTP JSON with `organization` and `stream-name` headers. OpenObserve creates
the trace stream on first ingestion and recognizes it as an LLM stream from the exported
`gen_ai.*` attributes.

Configuration is layered in this order:

1. Safe defaults with tracing disabled
2. `$CODEX_HOME/openobserve.json`
3. The nearest parent `<project>/.codex/openobserve.json`
4. Environment variables

Project configuration is intentionally limited to reducing collection: it may disable the plugin
or a content-capture option, and it may lower `max_chars`. Endpoint, organization, stream,
credentials, headers, service metadata, timeout, diagnostics, failure policy, and state storage are
controlled only by the user-level file or environment. Non-loopback endpoints must use HTTPS.

Environment variables take precedence:

| Variable                                 | Purpose                                               |
| ---------------------------------------- | ----------------------------------------------------- |
| `OPENOBSERVE_CODEX_ENABLED`              | Enable export with `true` or `1`                      |
| `OPENOBSERVE_CODEX_ENDPOINT`             | Base URL or full OTLP traces URL                      |
| `OPENOBSERVE_CODEX_ORGANIZATION`         | OpenObserve organization                              |
| `OPENOBSERVE_CODEX_STREAM_NAME`          | Trace stream, default `codex`                         |
| `OPENOBSERVE_CODEX_AUTHORIZATION`        | Complete `Authorization` header value                 |
| `OPENOBSERVE_CODEX_HEADERS`              | Additional headers as a JSON object                   |
| `OPENOBSERVE_CODEX_CAPTURE_CONTENT`      | Include prompts and assistant messages                |
| `OPENOBSERVE_CODEX_CAPTURE_REASONING`    | Include locally available reasoning summaries/content |
| `OPENOBSERVE_CODEX_CAPTURE_TOOL_CONTENT` | Include tool arguments and results                    |
| `OPENOBSERVE_CODEX_MAX_CHARS`            | Per-field character limit                             |
| `OPENOBSERVE_CODEX_ENVIRONMENT`          | Deployment environment attribute                      |
| `OPENOBSERVE_CODEX_SERVICE_NAME`         | OpenTelemetry service name                            |
| `OPENOBSERVE_CODEX_TIMEOUT_MS`           | Export timeout in milliseconds                        |
| `OPENOBSERVE_CODEX_DEBUG`                | Emit parser and exporter diagnostics to stderr        |
| `OPENOBSERVE_CODEX_FAIL_ON_ERROR`        | Make export failures fail the hook                    |
| `OPENOBSERVE_CODEX_STATE_DIRECTORY`      | Override deduplication-state storage                  |

The JSON file supports the snake-case keys shown in the example and equivalent camel-case keys.
Do not specify both forms of the same key.

## Trace Model

Each Codex turn becomes one trace:

```text
codex.turn
└── invoke_agent codex
    ├── chat <model>
    │   └── execute_tool <tool>
    └── execute_tool spawn_agent
        └── invoke_agent codex.subagent
            ├── chat <child-model>
            └── execute_tool <child-tool>
```

Important attributes include:

- `gen_ai.operation.name`
- `gen_ai.request.model` and `gen_ai.response.model`
- `gen_ai.input.messages` and `gen_ai.output.messages`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and cache usage
- `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, and `gen_ai.tool.call.result`
- `gen_ai.agent.id`, `gen_ai.agent.name`, and `gen_ai.conversation.id`
- `codex.turn.id` and `codex.thread.id`

Model-call boundaries are reconstructed heuristically because Codex transcripts do not persist a
stable identifier for every upstream response. The trace marks reconstructed generations with
`codex.reconstruction.confidence = "heuristic"`.

## Privacy

Content capture is disabled by default. Enabling it can export source code, prompts, assistant
responses, repository paths, tool arguments, tool results, credentials, or personal data contained
in a Codex session.

The plugin applies best-effort redaction for common authorization, key, password, secret, and token
patterns and truncates large values. Redaction is not a security boundary. Use a restricted
OpenObserve ingestion credential, configure stream retention appropriately, and do not enable
content capture for sessions whose data must not leave the machine.

Encrypted reasoning cannot be reconstructed. `capture_reasoning` exports only reasoning text that
Codex persisted locally.

## Troubleshooting

- Confirm the plugin is enabled and trusted in `/hooks`.
- Confirm `enabled` is `true`; export is intentionally off by default.
- For Codex Desktop, prefer the JSON configuration because GUI applications may not inherit shell
  environment variables.
- Set `OPENOBSERVE_CODEX_DEBUG=true` to show hook diagnostics.
- Verify the endpoint has no duplicated `/api/<org>/v1/traces` suffix.
- Verify the authorization value includes its scheme, such as `Basic` or `Bearer`.
- Look in the configured `codex` trace stream and filter `service_name = 'codex'`.

## Develop

```bash
npm ci
npm run format:check
npm run type-check
npm test
npm run build
```

The committed content-addressed file under `plugins/openobserve/dist/` is a self-contained bundle.
Its filename changes whenever executable content changes so Codex asks the user to review renewed
hook trust. Plugin installation does not run package-manager lifecycle scripts.
