import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';

process.env.MAILGUN_API_KEY ||= 'test-only-mailgun-key';

const {
  createEmailSender,
  MAX_EMAIL_MESSAGE_ID_LENGTH,
} = await import('../utils/sendEmail.js');

const DOMAIN = 'mail.example.test';
const DEFAULT_FROM = 'CampPics <no-reply@example.test>';
const SENT_AT = new Date('2026-07-31T15:00:00.000Z');

function createMailClient({ result, error, calls }) {
  return {
    messages: {
      async create(...args) {
        calls.push(args);
        if (error) throw error;
        return result;
      },
    },
  };
}

test('successful delivery persists only allowlisted metadata and returns the provider result unchanged', async () => {
  const secrets = Object.freeze({
    verificationToken: 'fixture-verification-token',
    resetToken: 'fixture-password-reset-token',
    resetUserId: 'fixture-reset-user-id',
    contactMessage: 'fixture-contact-form-message',
    arbitrarySecret: 'fixture-arbitrary-secret',
  });
  const templateData = Object.freeze({ ...secrets });
  const renderedHtml = Object.values(secrets).join('|');
  const providerResult = Object.freeze({
    id: '<provider-message-id@example.test>',
    message: 'Queued',
    status: 200,
    headers: Object.freeze({ authorization: 'fixture-provider-header' }),
    request: Object.freeze({ html: renderedHtml }),
    response: Object.freeze({ body: 'fixture-provider-response' }),
    sensitive: 'fixture-provider-sensitive-value',
  });
  const input = Object.freeze({
    to: 'camper@example.test',
    subject: 'fixture-arbitrary-secret subject',
    template: 'verify-account',
    templateData,
    userId: new mongoose.Types.ObjectId('64b7f2d4c9f1e8a123456789'),
    from: 'fixture-provider-from@example.test',
    futureSenderArgument: 'fixture-future-sender-secret',
  });
  const renderCalls = [];
  const providerCalls = [];
  const constructed = [];
  let saveCalls = 0;

  class EmailModel {
    constructor(metadata) {
      constructed.push(metadata);
    }

    async save() {
      saveCalls += 1;
    }
  }

  const sender = createEmailSender({
    async renderTemplate(...args) {
      renderCalls.push(args);
      return renderedHtml;
    },
    mailClient: createMailClient({ result: providerResult, calls: providerCalls }),
    EmailModel,
    async log() {
      assert.fail('successful delivery should not be reported as a failure');
    },
    now: () => SENT_AT,
    domain: DOMAIN,
    defaultFrom: DEFAULT_FROM,
  });

  const result = await sender(input);

  assert.strictEqual(result, providerResult);
  assert.equal(renderCalls.length, 1);
  assert.match(renderCalls[0][0], /views[\\/]emails[\\/]verify-account\.ejs$/);
  assert.strictEqual(renderCalls[0][1], templateData);
  assert.deepEqual(providerCalls, [[DOMAIN, {
    from: input.from,
    to: input.to,
    subject: input.subject,
    html: renderedHtml,
  }]]);
  assert.equal(saveCalls, 1);
  assert.strictEqual(constructed[0].userId, input.userId);
  assert.deepEqual(constructed, [{
    to: input.to,
    template: input.template,
    userId: input.userId,
    messageId: providerResult.id,
    sentAt: SENT_AT,
  }]);
  assert.deepEqual(
    Object.keys(constructed[0]).sort(),
    ['messageId', 'sentAt', 'template', 'to', 'userId'],
  );

  const persisted = JSON.stringify(constructed[0]);
  for (const value of [
    ...Object.values(secrets),
    input.subject,
    input.from,
    input.futureSenderArgument,
    providerResult.message,
    providerResult.headers.authorization,
    providerResult.response.body,
    providerResult.sensitive,
  ]) {
    assert.equal(persisted.includes(value), false, value);
  }
  assert.strictEqual(input.templateData, templateData);
  assert.strictEqual(providerResult.request.html, renderedHtml);
});

test('absent, null, undefined, and blank user IDs are omitted from metadata', async t => {
  const cases = [
    ['no userId argument', {}],
    ['undefined userId', { userId: undefined }],
    ['null userId', { userId: null }],
    ['blank userId', { userId: '' }],
  ];

  for (const [name, userIdInput] of cases) {
    await t.test(name, async () => {
      const providerResult = Object.freeze({
        id: `<${name.replaceAll(' ', '-')}@example.test>`,
        message: 'Queued',
      });
      const providerCalls = [];
      const constructed = [];

      class EmailModel {
        constructor(metadata) {
          constructed.push(metadata);
        }

        async save() {}
      }

      const sender = createEmailSender({
        renderTemplate: async () => '<p>rendered</p>',
        mailClient: createMailClient({
          result: providerResult,
          calls: providerCalls,
        }),
        EmailModel,
        async log() {},
        now: () => SENT_AT,
        domain: DOMAIN,
        defaultFrom: DEFAULT_FROM,
      });

      const input = {
        to: 'contact@example.test',
        subject: 'Contact form submission',
        template: 'email-contact-form-submission',
        ...userIdInput,
      };
      const returned = await sender(input);

      assert.strictEqual(returned, providerResult);
      assert.deepEqual(providerCalls, [[DOMAIN, {
        from: DEFAULT_FROM,
        to: input.to,
        subject: input.subject,
        html: '<p>rendered</p>',
      }]]);
      assert.deepEqual(constructed, [{
        to: input.to,
        template: input.template,
        messageId: providerResult.id,
        sentAt: SENT_AT,
      }]);
      assert.equal(Object.hasOwn(constructed[0], 'userId'), false);
    });
  }
});

test('constructor failure after provider success is reported but delivery still resolves', async () => {
  const persistenceError = Object.freeze(new Error('fixture constructor failure'));
  const providerResult = Object.freeze({ id: '<constructor@example.test>' });
  const providerCalls = [];
  const logCalls = [];

  class EmailModel {
    constructor() {
      throw persistenceError;
    }
  }

  const sender = createEmailSender({
    renderTemplate: async () => '<p>rendered</p>',
    mailClient: createMailClient({ result: providerResult, calls: providerCalls }),
    EmailModel,
    async log(...args) {
      logCalls.push(args);
    },
    now: () => SENT_AT,
    domain: DOMAIN,
    defaultFrom: DEFAULT_FROM,
  });

  const result = await sender({
    to: 'camper@example.test',
    subject: 'Subject',
    template: 'verify-account',
  });

  assert.strictEqual(result, providerResult);
  assert.equal(providerCalls.length, 1);
  assert.equal(logCalls.length, 1);
  assert.equal(
    logCalls[0][3].message,
    'Email delivery metadata persistence failed.',
  );
  assert.strictEqual(logCalls[0][3].error, persistenceError);
  assert.equal(persistenceError.message, 'fixture constructor failure');
});

test('save and logger failures after provider success cannot turn delivery into rejection', async () => {
  const persistenceError = Object.freeze(new Error('fixture save failure'));
  const loggerError = Object.freeze(new Error('fixture logger failure'));
  const providerResult = Object.freeze({ id: '<save@example.test>' });
  const providerCalls = [];
  const logCalls = [];
  let saveCalls = 0;

  class EmailModel {
    async save() {
      saveCalls += 1;
      throw persistenceError;
    }
  }

  const sender = createEmailSender({
    renderTemplate: async () => '<p>rendered</p>',
    mailClient: createMailClient({ result: providerResult, calls: providerCalls }),
    EmailModel,
    async log(...args) {
      logCalls.push(args);
      throw loggerError;
    },
    now: () => SENT_AT,
    domain: DOMAIN,
    defaultFrom: DEFAULT_FROM,
  });

  const result = await sender({
    to: 'camper@example.test',
    subject: 'Subject',
    template: 'verify-account',
  });

  assert.strictEqual(result, providerResult);
  assert.equal(providerCalls.length, 1);
  assert.equal(saveCalls, 1);
  assert.equal(logCalls.length, 1);
  assert.equal(
    logCalls[0][3].message,
    'Email delivery metadata persistence failed.',
  );
  assert.strictEqual(logCalls[0][3].error, persistenceError);
  assert.equal(persistenceError.message, 'fixture save failure');
  assert.equal(loggerError.message, 'fixture logger failure');
});

test('timestamp failure after provider success is a non-fatal metadata failure', async () => {
  const timestampError = Object.freeze(new Error('fixture timestamp failure'));
  const providerResult = Object.freeze({ id: '<timestamp@example.test>' });
  const logCalls = [];
  let constructorCalls = 0;

  class EmailModel {
    constructor() {
      constructorCalls += 1;
    }
  }

  const sender = createEmailSender({
    renderTemplate: async () => '<p>rendered</p>',
    mailClient: createMailClient({ result: providerResult, calls: [] }),
    EmailModel,
    async log(...args) {
      logCalls.push(args);
    },
    now() {
      throw timestampError;
    },
    domain: DOMAIN,
    defaultFrom: DEFAULT_FROM,
  });

  assert.strictEqual(await sender({
    to: 'camper@example.test',
    subject: 'Subject',
    template: 'verify-account',
  }), providerResult);
  assert.equal(constructorCalls, 0);
  assert.strictEqual(logCalls[0][3].error, timestampError);
});

test('rendering failure prevents delivery and persistence and rethrows by identity', async () => {
  const renderingError = Object.freeze(new Error('fixture rendering failure'));
  const loggerError = Object.freeze(new Error('fixture logger failure'));
  const providerCalls = [];
  const logCalls = [];
  let constructorCalls = 0;

  class EmailModel {
    constructor() {
      constructorCalls += 1;
    }
  }

  const sender = createEmailSender({
    async renderTemplate() {
      throw renderingError;
    },
    mailClient: createMailClient({ result: {}, calls: providerCalls }),
    EmailModel,
    async log(...args) {
      logCalls.push(args);
      throw loggerError;
    },
    domain: DOMAIN,
    defaultFrom: DEFAULT_FROM,
  });

  await assert.rejects(
    sender({
      to: 'camper@example.test',
      subject: 'Subject',
      template: 'verify-account',
    }),
    error => error === renderingError,
  );
  assert.equal(providerCalls.length, 0);
  assert.equal(constructorCalls, 0);
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0][3].message, 'Email template rendering failed.');
  assert.strictEqual(logCalls[0][3].error, renderingError);
  assert.equal(renderingError.message, 'fixture rendering failure');
  assert.equal(loggerError.message, 'fixture logger failure');
});

test('provider failure prevents persistence and rethrows by identity', async () => {
  const providerError = Object.freeze(new Error('fixture provider failure'));
  const loggerError = Object.freeze(new Error('fixture logger failure'));
  const providerCalls = [];
  const logCalls = [];
  let constructorCalls = 0;

  class EmailModel {
    constructor() {
      constructorCalls += 1;
    }
  }

  const sender = createEmailSender({
    renderTemplate: async () => '<p>rendered</p>',
    mailClient: createMailClient({ error: providerError, calls: providerCalls }),
    EmailModel,
    async log(...args) {
      logCalls.push(args);
      throw loggerError;
    },
    domain: DOMAIN,
    defaultFrom: DEFAULT_FROM,
  });

  await assert.rejects(
    sender({
      to: 'camper@example.test',
      subject: 'Subject',
      template: 'verify-account',
    }),
    error => error === providerError,
  );
  assert.equal(providerCalls.length, 1);
  assert.equal(constructorCalls, 0);
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0][3].message, 'Email provider delivery failed.');
  assert.strictEqual(logCalls[0][3].error, providerError);
  assert.equal(providerError.message, 'fixture provider failure');
  assert.equal(loggerError.message, 'fixture logger failure');
});

test('missing, non-string, and excessively long provider IDs are omitted', async t => {
  const cases = [
    ['missing', { status: 'queued' }],
    ['number', { id: 42 }],
    ['object', { id: { value: 'fixture-object-id' } }],
    ['long string', { id: 'x'.repeat(MAX_EMAIL_MESSAGE_ID_LENGTH + 1) }],
  ];

  for (const [name, providerResult] of cases) {
    await t.test(name, async () => {
      const constructed = [];

      class EmailModel {
        constructor(metadata) {
          constructed.push(metadata);
        }

        async save() {}
      }

      const sender = createEmailSender({
        renderTemplate: async () => '<p>rendered</p>',
        mailClient: createMailClient({ result: providerResult, calls: [] }),
        EmailModel,
        async log() {},
        now: () => SENT_AT,
        domain: DOMAIN,
        defaultFrom: DEFAULT_FROM,
      });

      const returned = await sender({
        to: 'camper@example.test',
        subject: 'Subject',
        template: 'verify-account',
      });

      assert.strictEqual(returned, providerResult);
      assert.equal(Object.hasOwn(constructed[0], 'messageId'), false);
      assert.deepEqual(constructed[0], {
        to: 'camper@example.test',
        template: 'verify-account',
        sentAt: SENT_AT,
      });
    });
  }
});
