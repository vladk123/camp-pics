# CampPics runtime configuration

The web entry point loads `dotenv/config` before application modules and parses
the environment once before constructing the Mongo session store, starting the
MongoDB connection, or opening the HTTP listener. Provider-supplied environment
variables remain authoritative; a local `.env` file is optional.

## Required variables

- `DB_URL`: MongoDB connection URL.
- `SESSION_SECRET`: Express session signing and session-store encryption secret.
- `CC_DOMAIN`: public CampPics HTTP or HTTPS origin.
- `CLOUDINARY_CLOUD_NAME`: Cloudinary account cloud name.
- `CLOUDINARY_KEY`: Cloudinary API key.
- `CLOUDINARY_SECRET`: Cloudinary API secret.
- `MAILGUN_API_KEY`: Mailgun API key.
- `MAILGUN_DOMAIN`: Mailgun sending domain.
- `MAILGUN_FROM`: default Mailgun sender, optionally including a display name.
- `ADMIN_EMAIL`: administrative contact destination.

Every required variable must be a nonblank string. Surrounding whitespace is
trimmed, control characters are rejected, and fixed maximum lengths are
enforced. Startup diagnostics never include a rejected value or an excerpt from
one. `DB_URL` is not decomposed or reproduced in diagnostics. This pass does not
introduce a minimum length for `SESSION_SECRET` or narrow email/provider format
validation.

## Optional variables and defaults

- `NODE_ENV`: `development` by default; accepts exactly `development`, `test`,
  or `production`.
- `COOKIE_NAME`: `connect.sid` by default. Configured values are trimmed and
  bounded to 256 characters; control characters are rejected.
- `PORT`: `3000` by default; a base-10 integer from 1 through 65535.
- `IP`: absent by default so Node uses its normal listen-host behavior.
  Configured values are trimmed, bounded to 253 characters, and are not resolved
  through DNS during parsing.
- `FIVE_MIN_NUM_REQ_BEFORE_LIMIT`: `100` by default; a base-10 integer from 1
  through 1,000,000.
- `ONE_MIN_NUM_REQ_BEFORE_SLOWDOWN`: `50` by default; a base-10 integer from 0
  through 1,000,000.
- `BLOCK_BOT_URL`: empty by default. Comma-delimited literal URL patterns are
  parsed by the existing bounded request-filtering parser.
- `IGNORE_URL`: empty by default. It uses the same existing parser for ignored
  not-found patterns.

Blank optional values use their defaults. Numeric values may have surrounding
whitespace, but fractions, signs, exponential notation, hexadecimal notation,
mixed text, and out-of-range values are rejected.

## Returned configuration shape

`parseRuntimeConfig(environment)` returns a new deeply frozen object:

```text
{
  environment: {
    name,
    isDevelopment,
    isTest,
    isProduction
  },
  database: {
    url
  },
  session: {
    secret,
    cookieName
  },
  publicSite: {
    domain
  },
  cloudinary: {
    cloudName,
    apiKey,
    apiSecret
  },
  mailgun: {
    apiKey,
    domain,
    from,
    adminEmail
  },
  server: {
    port,
    host
  },
  requestLimits: {
    fiveMinuteMaximum,
    oneMinuteDelayAfter
  },
  requestFiltering: {
    blockedPatterns,
    ignoredNotFoundPatterns
  }
}
```

The runtime object includes secrets because application services need them. It
must not be serialized, logged, placed in requests or sessions, or exposed
through response locals.

## Public-site origin rules

`CC_DOMAIN` must be an absolute HTTP or HTTPS URL with no username, password,
query, fragment, or application path. A single trailing slash is accepted. The
parser returns the normalized origin without a trailing slash, such as
`https://camppics.ca`. HTTP is allowed for local and development use. Other
schemes and malformed URLs are rejected without reproducing the input.

## Safe startup errors

Invalid input throws `RuntimeConfigurationError`. Its fixed public issue shape
is:

```text
{
  variable: "ENVIRONMENT_VARIABLE_NAME",
  reason: "missing | invalid-type | invalid-format | out-of-range | too-long | unsupported-value"
}
```

All discovered issues are retained in deterministic parser order. The Error
message includes names and reasons only. The frozen `issues` property is
non-enumerable, no original environment or parsed value is attached, and
`JSON.stringify(error)` produces an empty object. The startup reporter emits the
fixed operational message `Application startup configuration is invalid.` plus
only the safe issue entries, then requests a nonzero exit. Logger failure cannot
permit application startup.

## Secret handling

Real values must remain in deployment configuration or an ignored local `.env`
file. Never commit configuration values or credentials. Startup diagnostics
display environment-variable names and fixed reasons only.

## Deferred work

This startup-validation pass does not verify:

- actual MongoDB connectivity;
- MongoDB transaction support or transaction capability;
- real Mailgun credentials;
- real Cloudinary credentials;
- deployment-specific proxy topology;
- supported Node-version policy;
- npm dependency advisories;
- route-specific abuse limits.
