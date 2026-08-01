import {
  RuntimeConfigurationError,
  parseRuntimeConfig,
} from './runtimeConfig.js';

export const INVALID_RUNTIME_CONFIGURATION_MESSAGE =
  'Application startup configuration is invalid.';

function safeIssueList(error) {
  if (!(error instanceof RuntimeConfigurationError)) return Object.freeze([]);
  return Object.freeze(error.issues.map(issue => Object.freeze({
    variable: issue.variable,
    reason: issue.reason,
  })));
}

export function createSafeRuntimeConfigurationFailure(error) {
  return Object.freeze({
    message: INVALID_RUNTIME_CONFIGURATION_MESSAGE,
    issues: safeIssueList(error),
  });
}

function defaultReport({ message, issues }) {
  console.error(message);
  for (const issue of issues) {
    console.error(`Configuration issue: ${issue.variable} (${issue.reason}).`);
  }
}

function defaultFallbackOutput(message) {
  console.error(message);
}

/**
 * Invoke application construction only after runtime configuration is valid.
 */
export async function startWithRuntimeConfig({
  environment,
  start,
  parse = parseRuntimeConfig,
  report = defaultReport,
  fallbackOutput = defaultFallbackOutput,
  exit = code => process.exit(code),
}) {
  if (typeof start !== 'function') {
    throw new TypeError('A startup function is required.');
  }

  let runtimeConfig;
  try {
    runtimeConfig = parse(environment);
  } catch (error) {
    const failure = createSafeRuntimeConfigurationFailure(error);
    try {
      await report(failure);
    } catch {
      try {
        await fallbackOutput(failure.message);
        for (const issue of failure.issues) {
          await fallbackOutput(
            `Configuration issue: ${issue.variable} (${issue.reason}).`,
          );
        }
      } catch {
        // A failed fallback must not permit startup with invalid configuration.
      }
    } finally {
      await exit(1);
    }
    return undefined;
  }

  return start(runtimeConfig);
}
