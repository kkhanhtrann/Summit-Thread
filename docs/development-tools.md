# Development tools

## Gitar

Gitar reviews GitHub PRs and can diagnose CI failures and propose corrections. The GitHub App must have access to this repository, and the account plan/trial must support the requested auto-apply behavior. In Gitar Settings → Configuration, confirm `kkhanhtrann/Summit-Thread` is enabled. Repository review instructions live in `.gitar/review/instructions.md`, privacy rules in `.gitar/rules/privacy.md`, and review-fix criteria in `.gitar/config/apply.md`.

Open a feature PR targeting main, link its issue, wait for CI and the Gitar review, inspect findings, and enable auto-apply on that PR when appropriate. Criteria files alone do not enable it; default-branch criteria apply after merge. Keep CI required and merge decisions under team control. Disable automatic fixes from the PR or disable repository processing in Gitar Settings. Do not delete meaningful checks to obtain a passing result. If demonstrating a deliberate failure, label it as a controlled demonstration and retain its diagnosis/fix evidence.

Evidence: repository enabled in the signed-in Gitar configuration. PR review, failing-check diagnosis, Gitar-authored correction and passing-CI links will be recorded below after verification. They are not implied by configuration files.

## Dash0

Dash0 receives OpenTelemetry traces, structured logs and metrics from the backend and navigation/request/error/performance monitoring from the browser. Session recording is disabled. The existing `summit-thread-backend-dev` and `summit-thread-browser-dev` tokens are restricted to ingestion in the Summit Thread dataset. Backend and browser ingest tokens are separate; backend credentials must never use VITE_ names.

Configure ignored backend/.env: DASH0_BACKEND_TOKEN, DASH0_OTLP_ENDPOINT, DASH0_DATASET. Configure ignored web/.env.local: VITE_DASH0_BROWSER_TOKEN, VITE_DASH0_OTLP_ENDPOINT, VITE_DASH0_DATASET. Endpoint defaults to the Oregon ingress. Set dataset to its configured identifier. Restart the API/web watcher after changes. Remove the relevant token setting to disable exports. Revoke tokens in Dash0 Auth Tokens if necessary; do not paste tokens into proof or repository files.

The backend preload initializes instrumentation before importing the app; shutdown flushes exporters. Logger fields are allowlisted, sensitive content fields redacted, and HTTP query values scrubbed. Browser URL filtering removes attendee search content. Test privacy with labeled synthetic markers, never real participant data. Inspect trace/log attributes before expanding instrumentation.

Dash0 MCP uses a separate Reading-permission token or OAuth, not an ingest-only token. Its regional endpoint is `https://api.us-west-2.aws.dash0.com/mcp`. Register it with `codex mcp add dash0 --url https://api.us-west-2.aws.dash0.com/mcp`, authenticate with `codex mcp login dash0`, and verify a service/trace query against new foundation traffic. See the [official Dash0 MCP setup](https://www.dash0.com/hub/integrations/int_dash0_mcp/overview) and [Codex MCP configuration](https://developers.openai.com/codex/mcp/).

Verification: start services/API/web, open the status page, click Check again, then inspect summit-thread-web and summit-thread-backend in Dash0 using the current time range. Confirm browser request, API health span, PostgreSQL/search dependencies, structured http_request logs, and foundation.http.requests metrics. Verify synthetic content markers do not appear. Record sanitized observations and URLs below. If nothing arrives, check region, dataset identifier, ingest scope, token presence, proxy URL, and browser export/network errors; never print a token to troubleshoot.

## Verification record

Pending live integration checks. Keep observed evidence separate from automated tests and configured-but-unverified behavior. Append later feature investigations with symptom, time window, query, supported cause, fix, and successful recheck.
