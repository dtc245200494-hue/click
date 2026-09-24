# Scheduled Loadtest Dashboard

A small Node.js dashboard for **authorized HTTP load testing**. It was designed after reviewing the MIT-licensed [`alexfernandez/loadtest`](https://github.com/alexfernandez/loadtest) project, especially its client-pool and concurrency model, then adapted to add scheduled campaigns and a hard concurrency ceiling suitable for a small VPS.

## What is implemented

- Web dashboard for creating campaigns.
- Start/end timestamps.
- Exact target request count.
- Smart or even hourly distribution.
- Timezone-aware Smart scheduling.
- Capped async worker pool (default max 20 globally configurable; default per campaign 10).
- HTTP keep-alive and response streaming/discarding to keep RAM use low.
- Live Socket.IO stats and logs.
- Hard end-time cutoff: no new work is dispatched after the campaign window.
- External targets are denied unless their exact hostname is listed in `ALLOWED_TARGET_HOSTS`.
- Local smoke-test endpoint for development.

## Small VPS defaults

For 1 vCPU / 1 GB RAM, start with request-only mode and campaign concurrency 10. Raise gradually only after checking CPU, RAM, error rate and latency.

## Install

```bash
npm install
cp .env.example .env
# export values from .env in your process manager or shell
npm test
npm start
```

The server binds to `127.0.0.1:3005` by default. Use nginx/caddy plus authentication if you expose it on a VPS.

## Authorized targets

External targets are disabled until you set exact hostnames you own or are authorized to test:

```bash
ALLOWED_TARGET_HOSTS=staging.example.com,api.staging.example.com npm start
```

## Git/upstream

The local source was adapted from architectural ideas in `alexfernandez/loadtest` (MIT). See `UPSTREAM.md` for the inspected upstream revision.
