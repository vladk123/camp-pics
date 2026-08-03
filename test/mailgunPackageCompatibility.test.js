import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { test } from 'node:test';

import FormData from 'form-data';
import Mailgun from 'mailgun.js';

test('installed Mailgun accepts FormData and constructs the existing client API without HTTP', () => {
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  let requestCalls = 0;
  const unexpectedRequest = () => {
    requestCalls += 1;
    throw new Error('Mailgun client construction attempted an HTTP request.');
  };

  http.request = unexpectedRequest;
  https.request = unexpectedRequest;

  try {
    const mailgun = new Mailgun(FormData);
    const client = mailgun.client({
      username: 'api',
      key: 'test-only-placeholder-key',
      url: 'https://api.example.invalid',
    });

    assert.ok(client.messages);
    assert.equal(typeof client.messages.create, 'function');
    assert.equal(requestCalls, 0);
  } finally {
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
  }
});
