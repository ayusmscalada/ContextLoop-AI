---
title: Postmortem - Orders table migration lock contention
author: Sam Rivera
date: 2026-11-02
---

# Postmortem: orders table migration lock contention

On 2026-10-30 an agent-run migration on the Project Alpha orders table held an ACCESS EXCLUSIVE lock for 6 minutes. ALTER TABLE waited behind a long-running analytics query, then blocked all checkout writes. This is migration lock contention, and it is the third time this month.

Root cause: the database-migration skill does not set lock_timeout or statement_timeout, and it builds indexes without CREATE INDEX CONCURRENTLY.

Decision: agreed that all migrations set lock_timeout = '5s', use CREATE INDEX CONCURRENTLY, and backfill in batches. Sam Rivera owns the follow-up.

Action item: Sam will update the database-migration skill with lock-safe rules.
