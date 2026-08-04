# CampPics rate limiting

## Existing global protection

CampPics keeps its existing application-wide protections in `app.js`:

- a five-minute hard request limit using the runtime-configured `requestLimits.fiveMinuteMaximum` threshold;
- a one-minute slowdown using the runtime-configured `requestLimits.oneMinuteDelayAfter` threshold and the existing delay calculation;
- exclusions for the existing static-file paths; and
- the process-local bot-pattern block cache.

These global protections retain their existing order and apply in addition to the route-specific policies below.

## Route-specific policies

The authentication and contact policies each have their own counter and apply
only to the listed POST route.

| Operation | Route | Window | Maximum POST attempts |
| --- | --- | ---: | ---: |
| Login | `POST /user/login` | 15 minutes | 20 |
| Registration | `POST /user/register` | 60 minutes | 5 |
| Forgotten-password email request | `POST /user/forgot-password` | 60 minutes | 10 |
| Verification-email resend | `POST /user/resend-verification` | 60 minutes | 5 |
| Contact submission | `POST /other/contact` | 60 minutes | 5 |
| Monthly draw no-upload entry | `POST /other/monthly-draw/no-upload-entry` | 60 minutes | 5 |

The monthly draw no-upload-entry limiter runs after authentication and verified-
email enforcement. It permits five attempts per hour, counts successful and
unsuccessful submissions, and is keyed by the authenticated User ID. If an
authenticated ID is unexpectedly unavailable, it falls back to the canonical
client IP produced by the existing trusted client-IP helper. A deterministic,
server-authored entry `_id` combines the account and Eastern-Time month; the
mandatory built-in MongoDB `_id` uniqueness is the authoritative duplicate
protection. Its stable format is
`monthly-draw-no-upload:YYYY-MM:<lowercase 24-character ObjectId>`.

Password and account mutations use these additional policies:

| Operation | Routes | Window | Maximum attempts |
| --- | --- | ---: | ---: |
| Forgotten-password reset-form submission | `POST /user/forgot-password/:userId/:code` and `POST /user/forgot-password/:userId` | 60 minutes | 10 |
| Authenticated password change | `POST /user/change-password` | 60 minutes | 10 |
| Account deletion | `POST /user/delete-account` | 60 minutes | 5 |

Reset-form submissions are keyed by the default client-IP attribution because
they are unauthenticated. Both reset-form POST variants share one
reset-submission counter. That counter is separate from the forgotten-password
email-request counter.

Authenticated password changes and account deletion are keyed only by the
authenticated User ID and use separate counters. Authentication runs first, so
rejected unauthenticated requests do not consume either authenticated counter.
The account-deletion limiter runs before current-password verification, the
database transaction, media inventory and cleanup planning, cleanup-job
creation, session destruction, and immediate cleanup processing.

Administrator mutations use this existing shared policy:

| Operation | Routes | Window | Maximum attempts |
| --- | --- | ---: | ---: |
| Administrator user-status mutation | `POST /a/user/:id/block` and `POST /a/user/:id/unblock` | 15 minutes | 30 |
| Site-announcement save | `POST /a/announcements` | 15 minutes | 30 |

The administrator user-status limiter is keyed only by the authenticated
administrator User ID. Block and Unblock share one counter. `isAdmin` executes
before the limiter, so unauthenticated users and authenticated
non-administrators are rejected without consuming its capacity. The limiter
runs on site-announcement saves as well, so all three administrator mutations
share the same bounded allowance. For announcement saves it runs before form
validation and singleton database work. The limiter
runs before target-ID validation, self-target comparison, database work,
redirect or flash creation, and operational failure logging. Every Block and
Unblock attempt that reaches it counts, including malformed targets,
self-target attempts, nonexistent targets, successful operations, and database
failures.

Authenticated media mutations use these additional policies:

| Operation | Routes | Window | Maximum attempts |
| --- | --- | ---: | ---: |
| Photo upload | All park and campsite photo-upload POST routes | 10 minutes | 5 |
| YouTube video addition | All park and campsite video-add POST routes | 60 minutes | 20 |
| Media deletion | All park and campsite photo/video DELETE routes | 60 minutes | 60 |

Media mutation limits are keyed only by the authenticated User ID. Photo
upload, video addition, and media deletion have independent counters, while
all route variants for the same operation share that operation's counter. The
photo-upload limiter runs after authentication and before multipart parsing or
file buffering.

Public JSON APIs use these additional policies:

| Operation | Routes | Window | Maximum GET requests |
| --- | --- | ---: | ---: |
| Park-search API | `GET /camp/search-api` | 1 minute | 30 |
| Park-media API | `GET /camp/park/:parkSlug/media` | 5 minutes | 60 |
| Campsite-detail APIs | `GET /camp/park/:parkSlug/campsite/:campsiteSlug` and `GET /camp/park/:parkSlug/campground/:campgroundSlug/campsite/:campsiteSlug` | 5 minutes | 60 |

All three public API policies use express-rate-limit's default client-IP
attribution, which relies on Express `req.ip` and the existing trust-proxy
configuration. The two campsite-detail route variants share one campsite API
counter. Park search, park media, and campsite details have independent
counters, and none shares a counter with authentication, contact, media,
password, or account operations. The park-media JSON endpoint is covered by
this pass; the rendered park page is not covered by the park-media API limiter.

The public API limiters run before controller work. Park search is limited
before query parsing, cache loading, ranking, and serialization. Park media and
campsite details are limited before database queries, campsite resolution,
aggregation, serialization, and permission-flag calculation. Missing or
invalid search queries, empty results, not-found or malformed park and
campsite requests, successful responses, and server-error responses all count.

All attempts count, including successful, malformed, incorrect-password,
invalid-link, expired-link, and validation-failing submissions.

## Response behavior

An exceeded route-specific limit returns HTTP 429 with `Content-Type:
text/plain`, `Cache-Control: no-store`, and this fixed plain-text response body:

```text
Too many attempts. Please try again later.
```

The response does not redirect, create a flash message, log the rejection, or
include account, request, counter, session, IP, reset, verification, search
query, slug, URL, header, or media details.

## Process-local limitation

The current counters live in process memory and reset whenever the process restarts. Separate web dynos would have separate counters. This is acceptable for the current single-instance, basic abuse-prevention stage, but it is not distributed-bot protection and rate limiting alone does not prevent distributed attacks.

The monthly draw no-upload-entry counter is process-local as well and resets
with the process. Its deterministic `_id` and MongoDB's mandatory built-in
`_id` uniqueness remain authoritative across processes and retries.

The public API, authenticated media, password-change, account-deletion,
administrator user-status, and reset-form submission counters are also
process-local. They reset whenever the process restarts, and separate web dynos
do not share state. Route-specific process-local coverage is now implemented
for the currently identified public and mutation endpoints, but rate limiting
alone does not prevent distributed attacks, rotating-IP scraping, compromised
administrator accounts, or abuse across multiple dynos. Before CampPics uses
multiple web dynos, every limiter must move to a separate shared-store instance
with a unique prefix so all policies remain independent across processes.

## Deferred layers

Later passes still need:

- migration of every limiter to a separate shared-store instance with a unique
  prefix before multiple dynos.
