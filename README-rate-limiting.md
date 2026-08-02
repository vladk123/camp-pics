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

All attempts count, including successful and invalid submissions.

## Response behavior

An exceeded route-specific limit returns HTTP 429 with a fixed plain-text response and `Cache-Control: no-store`. The response does not redirect, create a flash message, log the rejection, or include account, request, counter, session, IP, reset, or verification details.

## Process-local limitation

The current counters live in process memory and reset whenever the process restarts. Separate web dynos would have separate counters. This is acceptable for the current single-instance, basic abuse-prevention stage, but it is not distributed-bot protection and rate limiting alone does not prevent distributed attacks.

The authenticated media counters are also process-local. They reset whenever
the process restarts, and separate web dynos do not share state. Before
CampPics uses multiple web dynos, each limiter must move to its own shared-store
instance with a unique prefix so all policies remain independent across
processes.

## Deferred layers

Later passes still need separate abuse-control policies for:

- account deletion;
- password-changing and password-reset submissions;
- public campsite APIs;
- the park search API; and
- administrator mutations.
