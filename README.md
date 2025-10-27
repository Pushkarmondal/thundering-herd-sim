# Thundering Herd Problem — Lab Guide (Node.js + Redis + PostgreSQL)

![Thundering Herd Spike](./Screenshot%202025-10-27%20at%2019.45.07.png)

## Overview
Simulate and fix the thundering herd problem: when a popular cache key expires for many users at once, every request misses cache and stampedes the database. You will first build a naive system, then measure the meltdown, and finally implement production-grade mitigations.

Timebox: 3–4 hours.

## Learning Goals
- Understand why synchronized cache expiry causes DB overload.
- Measure hit/miss ratio, DB connections, and latency distributions.
- Reproduce the herd using a controlled load test.
- Apply three mitigations:
  - Jittered TTLs.
  - Request coalescing (single-flight) so only one fetch runs per key.
  - Cache warming using a Redis lease (Lua) to avoid duplicate work.

## Tech Stack
- Node.js REST API (any framework you prefer)
- Redis for cache
- PostgreSQL for source of truth
- Artillery for load generation

## Prerequisites
- Node.js LTS installed
- Redis CLI and psql (optional but helpful)
- Artillery installed globally or run via npx

## High-Level Architecture
- Client → API → Redis (cache) → PostgreSQL (DB)
- API exposes `GET /users/:id` that returns a user profile.
- Cache TTL initially set to 60 seconds for all user keys.

## Dataset and Scale
- Seed the DB with 10,000 users (IDs 1..10000) with small JSON profiles.
- Prepopulate Redis cache with the same 10,000 users, all expiring at exactly t=60s.
- No request deduplication in the baseline.

## What You Will Build
- REST API server
- Redis cache layer with TTL 60s (baseline)
- DB access layer with a connection pool
- Simple metrics endpoints/logging for:
  - Cache hits/misses
  - Request latency (track P50/P95/P99)
  - Active DB connections / pool usage
  - Number of identical queries hitting DB

## Baseline (Build)
1. Implement `GET /users/:id`:
   - Check Redis key for the user.
   - On miss: query Postgres, serialize result, set Redis with TTL=60s, return.
2. Seed DB with 10k rows.
3. Warm Redis cache with the same 10k keys and set their TTL to expire together at t=60s.
4. Add logging/metrics for:
   - Cache hit or miss per request
   - Start/end timestamps to compute latency
   - DB pool stats (available/active/idle)
   - Optional: an endpoint to expose counters for quick inspection

Important: keep it intentionally naive—no jitter, no coalescing.

## Break (Load Test)
Goal: trigger the herd at second 61 when all keys expire at once.

- Start the API and confirm health.
- Prepare an Artillery scenario that:
  - Issues concurrent `GET /users/:id` requests for randomly selected IDs in 1..10000.
  - Ramps to 5000 concurrent requests precisely after 60s of warm period (so cache is warm first, then expires).
- Run the test so the spike starts at t≈61s.

Expected outcome (baseline):
- Massive cache misses
- DB pool saturation
- P95/P99 latency spikes (P99 > 10s)
- Many concurrent identical queries for the same user IDs

## Measure (What to Capture)
- DB: active connections and waiting queries
  - Inspect `pg_stat_activity` and pool stats during the spike.
- Cache: hit/miss ratio before and during spike
- API latency: P50, P95, P99
- Query duplication: count identical SQLs for the same user IDs within a short window

Record evidence:
- Screenshots or copies of metrics/graphs/logs
- A short note of observed peak values (e.g., max active connections, worst P99)

## Fix — Step 1: Jittered Expiration
Add a random offset to cache TTLs to decorrelate expirations.
- Instead of a fixed 60s, use 60s plus a uniform random jitter in the range 0–10 minutes (choose a range suitable for your data freshness needs).
- Apply to every set operation for user profiles.
- Re-run load test. Expect smoother expirations, fewer synchronized misses, reduced P95/P99.

Success criteria:
- More stable hit ratio
- Lower peak DB connections during spikes
- Lower P99 vs baseline

## Fix — Step 2: Request Coalescing (Single-Flight)
Ensure only one inflight fetch per cache key at a time.
Design options:
- In-process per-key lock map.
- Distributed lease via Redis for multi-instance scenarios.

Behavioral goal:
- First request for key K performs the DB fetch and cache set.
- Concurrent requests for K wait for the first to finish and then read from cache/memory.
- Handle timeouts and errors: waiting requests should fail fast if the leader fails or times out.

Re-run load test. Expect significant drop in duplicate DB work and improved tail latency.

## Fix — Step 3: Cache Warming with Redis Lease (Lua)
Use a short-lived lease key to control who populates the cache and avoid dogpiles:
- On cache miss, try to acquire a lease key for the user ID with a brief TTL ("work in progress").
- If lease acquired: fetch from DB, set the value with TTL + jitter, then release the lease.
- If lease not acquired: wait/poll briefly for the value to appear, then serve from cache; apply a timeout fallback to avoid waiting forever.

Re-run load test. Expect:
- Minimal duplicate DB queries per key
- Much lower P99 compared to baseline
- DB pool no longer saturates

## Validation Matrix
Run three experiments and capture metrics each time:
1. Baseline: fixed 60s TTL, no coalescing, no lease
2. Jitter only
3. Jitter + single-flight + lease warming

For each, collect:
- Cache hit/miss over time
- DB active connections and waits
- Request latency P50/P95/P99
- Count of duplicate queries per key

## Suggested Project Structure (flexible)
- api/ (server, routes, middleware)
- cache/ (redis client, TTL strategy)
- db/ (pool, queries, seed scripts)
- scripts/ (seed, warmup, load profiles)
- metrics/ (simple counters or exporter)
- docker/ (compose files, service configs)

Use whatever structure you prefer; keep responsibilities separated for clarity.

## Operational Checklist
- API starts and connects to Redis + Postgres
- Seeded 10k users in DB
- Warmed Redis with 10k keys
- Confirm cache warms and then expires at t=60s
- Artillery script prepared to burst at t≈61s to 5000 concurrent
- Metrics capture set up and validated before each run

## Evidence to Submit
- Short write-up (1–2 pages):
  - What happened in baseline and why
  - What changed with each fix and why
  - Final recommendations
- Screenshots/logs for:
  - pg_stat_activity / pool graphs during spike
  - Cache hit/miss curves
  - Latency distributions (P50/P95/P99)
  - Duplicate query counts

## Tips and Pitfalls
- Ensure all 10k keys truly expire together in baseline; otherwise the herd won’t reproduce.
- DB pool size should be intentionally limited to expose saturation under load.
- Add timeouts for coalescing waiters to avoid "forever waits" if the leader fails.
- Jitter range should be large enough to smear expiries but acceptable for freshness.
- Release lease robustly; guard against lost updates and ensure eventual consistency.

## Stretch Goals (Optional)
- Add Prometheus + Grafana for nicer charts.
- Compare in-process vs Redis-based single-flight under multi-instance API replicas.
- Introduce stale-while-revalidate: serve stale cache briefly while one request refreshes in background.
- Use a circuit breaker when DB is overloaded.

---
