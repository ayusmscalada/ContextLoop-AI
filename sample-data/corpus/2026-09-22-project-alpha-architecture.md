---
title: Project Alpha - Payment Platform Architecture
author: Maya Chen
date: 2026-09-22
---

# Project Alpha - Payment Platform Architecture

Project Alpha is Northwind Labs' new payment processing platform. Project Alpha owner: Priya Patel. Engineering lead is Maya Chen.

## Customers
The launch customer is customer Acme Retail, followed by customer Globex Logistics in Q1.

## Components
- Checkout API (TypeScript, Node.js) receives orders and creates payment intents.
- Charge service (Python, FastAPI) calls the PayFlow API to authorize and capture payments.
- Ledger stored in PostgreSQL with double-entry tables; Redis for queues and rate limiting.
- Webhooks from PayFlow confirm settlement; signatures are verified with HMAC.

## Reliability requirements
- p99 checkout latency under 800 ms.
- No duplicate charges under any failure mode.
- All external calls must have explicit timeouts.

## Open questions
- Should settlement reconciliation run hourly or daily?
