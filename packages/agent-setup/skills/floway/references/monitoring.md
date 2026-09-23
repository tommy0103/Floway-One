# Playground and monitoring

Read `concepts.md` first. **Playground** sends a representative model request through Floway. Choose a chat model and the intended client-facing format, submit a short prompt, and inspect returned text, completion and any error. A model appearing in the catalog does not establish that it can answer. A successful client-facing format proves that route worked for that request; Floway may translate it before contacting the Upstream.

**Requests** shows captured request records and details, including status, timing, route and bodies where available. It may be empty because the relevant API key has **Request dump retention** off; do not infer that no traffic occurred. Select the correct API key and request before interpreting an error. Bodies may contain prompts, responses, or credentials, so avoid quoting them unless the owner explicitly needs that content; mask secrets.

**Usage** aggregates requests, token counts and estimated cost over a selected time range. Check the range, filters, and grouping (model, Upstream, user, or API key) before reporting a number. An empty chart means no matching records in that view. **Performance** reports latency and output speed, with percentile and breakdown choices. State the metric, percentile, time range, and filters when comparing services. Do not treat estimated cost or p95 latency as a per-request value.

When diagnosing a failed request, correlate model, API key scope, route, time and status. Use the specific error and Upstream settings to decide the next check. If a minimal model test works but the agent's actual request fails, investigate request-specific features or role compatibility rather than disabling the endpoint format.
