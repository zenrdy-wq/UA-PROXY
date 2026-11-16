# ua-proxy

A self-hosted reverse proxy for OpenAI-compatible AI gateways. It sits between
your clients and one or more upstream providers, injects the headers those
providers require, normalizes the wire format, keeps long streams alive, and
adds a local dashboard for configuration, history, and testing.

No external dependencies — plain Node.js. Ships with a CLI/TUI, a browser
dashboard, request history, and a test suite.

## Features

- **Per-channel routing** — expose one upstream per route:
  `/v1/...` (default) or `/<channel>/v1/...`.
- **Header injection** — send a custom `User-Agent` (or any headers) that some
  gateways require before they accept a request.
- **Credential isolation** — store provider API keys on the proxy and swap them
  in per channel; clients only ever see your proxy token.
- **API dialect bridge** — accept `/v1/chat/completions` and transparently
  forward to a provider that only speaks the OpenAI Responses API
  (`/v1/responses`), translating requests, JSON replies, SSE streams, and tool
  calls in both directions.
- **Automatic parameter negotiation** — when an upstream rejects a request with
  `Unsupported parameter: '<name>'`, the proxy removes that field, retries, and
  remembers the decision for that model.
- **Stream hardening** — periodic keep-alive frames during long silences, and
  filtering of empty SSE frames that break strict clients.
- **Public or local access** — loopback by default; optional token-gated public
  exposure through a tunnel, with separate dashboard and API auth.
- **Observability** — request history in SQLite, error classification, latency
  and token usage, filterable activity view.
- **Playground & TUI** — test any channel/model from the browser or terminal
  without touching client configuration.

## How it works

```
 client (OpenAI-compatible)
        │  Authorization: Bearer <proxy token>
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │ ua-proxy :8787                                           │
 │  route /<channel>/v1/... → upstream base URL             │
 │  inject headers + provider key                           │
 │  optional dialect bridge (chat ↔ responses)              │
 │  stream heartbeat / SSE sanitizing / param retry         │
 └──────────────────────────────────────────────────────────┘
        │
        ▼
 upstream provider(s): https://api.example.com/v1
```

The dashboard (default `:8788`) manages channels, reads the local history, and
runs the playground. It never exposes provider keys through state or history
responses; reveal/copy is an explicit, CSRF-protected action.

## Requirements

- Node.js 24+ recommended (the history store uses the built-in `node:sqlite`).
  On Node 22.5–23.3, start the services with `--experimental-sqlite`.
- Linux or macOS. Windows is untested.
- No npm dependencies.

## Quick start

```bash
git clone https://github.com/zenrdy-wq/UA-PROXY.git
cd UA-PROXY

cp config.example.json config.json      # keep config.json private
# edit config.json: baseUrl, apiKey, authToken

./uaproxy start                        # systemd service, or:
node server.js                         # foreground
```

Run the dashboard in a second process (or install both services):

```bash
node dashboard.js        # http://127.0.0.1:8788
```

Create a proxy token either in `config.json` (`authToken`, at least 32 chars)
or from the dashboard (Channels → Generate new). Use it as the API key from
your clients.

## Configuration

`config.json` (or the path in `UA_PROXY_CONFIG`):

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "logLevel": "info",
  "publicMode": false,
  "heartbeatMs": 20000,
  "maxBodyBytes": 10485760,
  "defaultUpstream": "provider-a",
  "upstreams": {
    "provider-a": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "REPLACE_WITH_PROVIDER_KEY",
      "headers": {
        "user-agent": "ua-proxy/1.0",
        "originator": "cli"
      },
      "injectSessionHeaders": false
    }
  },
  "authToken": "REPLACE_WITH_32_CHAR_PROXY_TOKEN",
  "accessRevoked": false
}
```

### Global fields

| Field | Default | Purpose |
|---|---|---|
| `host` | `127.0.0.1` | Listen address. Non-loopback requires `publicMode`. |
| `port` | `8787` | Gateway port. |
| `logLevel` | `info` | `error`, `warn`, `info`, `debug`. |
| `publicMode` | `false` | Require the proxy token on every request (fail-closed). |
| `authToken` | — | Proxy API key. Required when `publicMode` is on. |
| `heartbeatMs` | `0` | Default SSE keep-alive interval; `0` disables. |
| `maxBodyBytes` | `10485760` | Request body cap. |
| `defaultUpstream` | — | Channel used when the path does not name one. |
| `accessRevoked` | `false` | Reject all gateway traffic until a new token is generated. |
| `upstreams` | — | Channel map; at least one entry. |

### Per-channel fields

| Field | Default | Purpose |
|---|---|---|
| `baseUrl` | — | Upstream base, e.g. `https://api.example.com/v1`. |
| `apiKey` | — | Provider key injected as `Authorization` / `x-api-key`. |
| `headers` | — | Headers injected on every request; they win over client values. |
| `enabled` | `true` | Disable a channel without deleting it. |
| `injectSessionHeaders` | `false` | Add `session-id`, `thread-id`, `x-client-request-id`. |
| `sanitizeSse` | `true` | Drop empty `data: null` frames from SSE. |
| `heartbeatMs` | global | Per-channel keep-alive interval; `0` disables. |
| `stripBodyKeys` | — | Top-level JSON fields removed before forwarding. |
| `chatVia` | — | `"responses"` serves `/chat/completions` through `/responses`. |

Body rewriting, the dialect bridge, and the retry logic all operate on the
buffered request body, so `maxBodyBytes` bounds how large a bridged request may
be.

## API usage

### Routing

| Request | Reaches |
|---|---|
| `POST /provider-a/v1/chat/completions` | `https://api.example.com/v1/chat/completions` |
| `POST /provider-a/chat/completions` | same (duplicate `/v1` is collapsed) |
| `POST /v1/chat/completions` | `defaultUpstream` |
| `GET /_health` | local health JSON |

The authorization header is not stored or logged. When a channel has `apiKey`,
the proxy replaces whatever the client sent.

### Authentication

With `publicMode: true` (or behind the public gateway), every gateway request
needs the proxy token:

```bash
curl http://127.0.0.1:8787/provider-a/v1/chat/completions \
  -H "Authorization: Bearer $UA_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"model-name","messages":[{"role":"user","content":"Hello"}]}'
```

Streaming works the same way; the response is passed through as SSE:

```bash
curl -N http://127.0.0.1:8787/provider-a/v1/chat/completions \
  -H "Authorization: Bearer $UA_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"model-name","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

### Responses-only providers (`chatVia`)

Some providers expose only the OpenAI Responses API. Set `"chatVia":
"responses"` on that channel and the proxy translates in both directions:

- request: `messages` → `input` items, `system`/`developer` → `instructions`,
  assistant `tool_calls` → `function_call`, `tool` results →
  `function_call_output`, flattened tools, `max_tokens` → `max_output_tokens`,
  `reasoning_effort` → `reasoning`, `response_format` → `text.format`;
- reply: text parts → `message.content`, function calls → `message.tool_calls`,
  usage → `prompt_tokens` / `completion_tokens`, `finish_reason` derived from the
  response;
- stream: Responses SSE events are re-emitted as `chat.completion.chunk` frames
  (including incremental tool-call arguments and a usage chunk), ending in
  `data: [DONE]`.

Native `/responses` requests are never touched. Override per request with
`x-ua-chat-via: responses` (force on) or `x-ua-chat-via: off` (force
passthrough). Supported for chat completions only; Anthropic-style `/messages`
is forwarded untouched.

### Unsupported-parameter retry

If an upstream answers `400` with `Unsupported parameter: '<name>'`, the proxy
removes that field from the outgoing body — including after dialect
translation — retries up to four times, and records the decision per
`(channel, model)` for 30 minutes so later requests skip the field up front.
The retry is logged at `warn`. This keeps clients that always send
`temperature` usable with models that reject sampling fields.

### Stream handling

- Idle SSE connections receive `: keep-alive` comment frames every
  `heartbeatMs`; comments are ignored by compliant parsers.
- `data: null` frames are dropped when `sanitizeSse` is on (some gateways emit
  them between real chunks and strict clients abort on them).
- If a stream ends without a completion marker, the request is recorded as a
  failed stream instead of a success.

## Dashboard

`node dashboard.js` serves `http://127.0.0.1:8788`:

- **Overview** — public base URL, proxy key state, lifetime counters, latency.
- **Activity** — filterable history (channel, status, time), request search,
  error inspector with a classified diagnosis and suggested next step.
- **Channels** — per-provider base URL, key, headers, enable/disable, model
  catalog browsing, and route tests. Reveal/copy of secrets requires an
  explicit same-origin, CSRF-protected action.
- **Playground** — multi-turn chat with system prompt, stream toggle, token
  limit, temperature, and timing/usage readout.
- **Settings** — token generation/revocation and gateway defaults.

History is stored in `runtime/history.sqlite` (SQLite WAL) with 30-day /
~50,000-row retention. It records method, channel, endpoint class, status,
duration, origin, and a diagnosis — never prompts, response bodies, query
strings, or credentials.

## Terminal UI

```bash
./uaproxy tui
```

Navigate channels, edit URLs, keys and headers, browse model catalogs, run a
prompt, and review recent requests. Secrets are shown as `set` / `not set`.

## Running as a service

The `uaproxy` script wraps systemd:

```bash
./uaproxy start | stop | restart | status | logs
```

Two units are expected: `ua-proxy.service` (gateway) and
`ua-proxy-dashboard.service` (dashboard). Both can run unprivileged. A typical
unit:

```ini
[Unit]
Description=ua-proxy gateway
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/ua-proxy/server.js
WorkingDirectory=/opt/ua-proxy
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

### Optional public exposure

The gateway and dashboard bind loopback by default. To reach them from other
devices, put a tunnel or reverse proxy in front and enable `publicMode` so the
API stays fail-closed. Two auth layers are supported and should stay separate:
the dashboard login (browser/management) and the proxy token (API clients).
`Funnel.Caddyfile`, `remote-credentials.json`, and `runtime/` are generated
locally and must never be committed.

## Security notes

- Keep `config.json`, `remote-credentials.json`, `runtime/`, and logs private
  (the installer sets owner-only permissions).
- The proxy never writes provider keys or proxy tokens to history, logs, or
  error text; the error inspector keeps fixed descriptions and conservative
  error codes only.
- Client-supplied `authorization`, `cookie`, `x-api-key`, forwarding, and tunnel
  headers are stripped before forwarding.
- A channel can be disabled without deleting its key; token revocation is
  immediate and blocks gateway traffic even if the old token is presented.
- Rotate the proxy token after sharing it; dashboard password recovery lives in
  `remote-credentials.json` on the host.

## Testing

No real provider is contacted by the test suite; every test uses local mock
servers.

```bash
node responses-bridge.test.js   # chat ↔ responses mapping, JSON + SSE + tools
node retry-params.test.js       # 400 retry, parameter memory, per-model scope
node config-store.test.js       # config validation and atomic writes
node features.test.js           # dashboard, history, playground, SSE edges
node channels.test.js           # channel CRUD, token lifecycle
node funnel.test.js             # public edge auth/origin/isolation (needs Funnel.Caddyfile)
node proxy.integration.test.js  # proxy routing and header injection
node test-rewrite.js            # stripBodyKeys
node test-sanitizer.js          # SSE null-frame filtering
node test-sse-edge.js           # SSE parser boundaries
node test-heartbeat.js          # keep-alive frames
node model-probe.test.js        # catalog probing
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401 unauthorized` | Missing/incorrect proxy token; `publicMode` is on. |
| `403 Channel disabled` | Channel is disabled or access was revoked. |
| `400 Unsupported parameter` | Fixed automatically; check logs for the retry line. |
| `402` / `429 upstream` | Provider quota or rate limit; check the provider account. |
| `502` with `stream_incomplete` | Upstream closed the stream early; retry manually. |
| `404 unknown upstream` | Path does not begin with a configured channel. |
| Long silence then disconnect | Raise or enable `heartbeatMs` for that channel. |

Error classifications are intentionally generic: they describe the observed
response (auth, quota, rate limit, restricted, invalid, unavailable, network,
timeout, stream) and never persist provider text that could echo prompts or
credentials.

## Project layout

```
server.js              gateway: routing, headers, bridge, retries, streaming
responses-bridge.js    chat ⇄ responses translation (request/JSON/SSE/tools)
lib.js                 config, routing, header construction, SSE helpers
config-store.js        config validation and atomic writes
dashboard.js           local dashboard server
playground.js          dashboard playground backend
manager.js             dashboard actions (channels, keys, probes)
history.js             SQLite request history
diagnostics.js         error classification
telemetry.js           counters and export
tui.js                 terminal UI
public-gateway.js      public-edge request forwarding
web/                   dashboard assets
*.test.js              isolated test suites
```
