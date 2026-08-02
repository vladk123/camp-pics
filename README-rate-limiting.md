# CampPics rate limiting

## Existing global protection

CampPics keeps its existing application-wide protections in `app.js`:

- a five-minute hard request limit using the runtime-configured `requestLimits.fiveMinuteMaximum` threshold;
- a one-minute slowdown using the runtime-configured `requestLimits.oneMinuteDelayAfter` threshold and the existing delay calculation;
- exclusions for the existing static-file paths; and
- the process-local bot-pattern block cache.

These global protections retain their existing order and apply in addition to the route-specific policies below.

## Route-specific policies

Each policy has its own counter and applies only to the listed POST route.

| Operation | Route | Window | Maximum POST attempts |
| --- | --- | ---: | ---: |
| Login | `POST /user/login` | 15 minutes | 20 |
| Registration | `POST /user/register` | 60 minutes | 5 |
| Forgotten-password email request | `POST /user/forgot-password` | 60 minutes | 10 |
| Verification-email resend | `POST /user/resend-verification` | 60 minutes | 5 |
| Contact submission | `POST /other/contact` | 60 minutes | 5 |

All attempts count, including successful and invalid submissions.

## Response behavior

An exceeded route-specific limit returns HTTP 429 with a fixed plain-text response and `Cache-Control: no-store`. The response does not redirect, create a flash message, log the rejection, or include account, request, counter, session, IP, reset, or verification details.

## Process-local limitation

The current counters live in process memory and reset whenever the process restarts. Separate web dynos would have separate counters. This is acceptable for the current single-instance, basic abuse-prevention stage, but it is not distributed-bot protection and rate limiting alone does not prevent distributed attacks.

Before CampPics uses multiple web dynos, each limiter must move to its own shared-store instance with a unique prefix so the five policies remain independent across processes.

## Deferred layers

Later passes still need separate rate-limit policies for:

- uploads;
- media deletion;
- account deletion;
- public campsite APIs;
- the park search API; and
- administrator mutations.
