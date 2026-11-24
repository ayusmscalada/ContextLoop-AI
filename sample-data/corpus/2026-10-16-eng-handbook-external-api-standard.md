---
title: Engineering Handbook - External API Call Standard
author: Alice Morgan
date: 2026-10-16
---

# External API Call Standard

Following engineering meeting #018 we standardized how every service and every AI agent calls external APIs.

1. Set an explicit client timeout on every request (800 ms default for payment APIs).
2. Retry only transient errors: timeouts, 5xx responses and 429 rate limits. Never retry 4xx validation errors such as a declined card.
3. Use exponential backoff starting at 200 ms with jitter, at most three retries.
4. Honor the Retry-After header when a provider rate limits us.
5. Every write carries an Idempotency-Key that is reused across retries.
6. Log the final failure with attempt count and last error.

This standard applies to Project Alpha and Project Beacon.
