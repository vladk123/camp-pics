(function initializeCsrfHelper(global) {
  'use strict';

  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const INVALID_TOKEN_CODE = 'INVALID_CSRF_TOKEN';
  const INVALID_TOKEN_MESSAGE =
    'Your security token is invalid or expired. Refresh the page and try again.';

  function getToken() {
    const meta = global.document?.querySelector('meta[name="csrf-token"]');
    const token = meta?.getAttribute('content');
    return typeof token === 'string' && token.length > 0 ? token : null;
  }

  function getMethod(input, options) {
    const method = options.method ?? input?.method ?? 'GET';
    return String(method).toUpperCase();
  }

  function getUrl(input) {
    const value = typeof input === 'string' || input instanceof URL
      ? input
      : input?.url;
    return new URL(value, global.location.href);
  }

  async function csrfFetch(input, options = {}) {
    const method = getMethod(input, options);
    const url = getUrl(input);
    const unsafe = !SAFE_METHODS.has(method);
    const sameOrigin = url.origin === global.location.origin;

    if (unsafe && !sameOrigin) {
      throw new Error('Unsafe cross-origin requests are not allowed by CampPicsCsrf.');
    }

    const fetchOptions = { ...options };
    if (fetchOptions.credentials === undefined) {
      fetchOptions.credentials = input?.credentials || 'same-origin';
    }

    if (unsafe) {
      const token = getToken();
      if (!token) {
        throw new Error('The page security token is unavailable. Refresh the page and try again.');
      }

      const sourceHeaders = options.headers ?? input?.headers;
      const headers = new Headers(sourceHeaders);
      headers.set('X-CSRF-Token', token);
      fetchOptions.headers = headers;
    }

    return global.fetch(input, fetchOptions);
  }

  function responseErrorMessage(response, payload, fallbackMessage) {
    if (response?.status === 403 && payload?.code === INVALID_TOKEN_CODE) {
      return INVALID_TOKEN_MESSAGE;
    }

    return typeof payload?.error === 'string' && payload.error
      ? payload.error
      : fallbackMessage;
  }

  global.CampPicsCsrf = Object.freeze({
    fetch: csrfFetch,
    getToken,
    responseErrorMessage,
  });
})(window);
