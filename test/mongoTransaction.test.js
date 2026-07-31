import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MONGO_TRANSACTION_UNAVAILABLE,
  MongoTransactionUnavailableError,
  runMongoTransaction,
} from '../utils/mongoTransaction.js';

function makeConnection({ withTransaction, endSession } = {}) {
  const calls = {
    startSession: 0,
    withTransaction: 0,
    endSession: 0,
  };
  const session = {
    async withTransaction(callback, options) {
      calls.withTransaction += 1;
      if (withTransaction) return withTransaction(callback, options);
      return callback();
    },
    async endSession() {
      calls.endSession += 1;
      return endSession?.();
    },
  };
  return {
    calls,
    session,
    connection: {
      async startSession() {
        calls.startSession += 1;
        return session;
      },
    },
  };
}

describe('runMongoTransaction', () => {
  test('starts a session, passes it to work, returns work result and ends', async () => {
    const harness = makeConnection();
    const expected = { committed: true };
    let receivedSession;

    const result = await runMongoTransaction(async session => {
      receivedSession = session;
      return expected;
    }, {
      connection: harness.connection,
    });

    assert.equal(result, expected);
    assert.equal(receivedSession, harness.session);
    assert.deepEqual(harness.calls, {
      startSession: 1,
      withTransaction: 1,
      endSession: 1,
    });
  });

  test('ends the session and preserves the exact operation error', async () => {
    const harness = makeConnection();
    const operationError = new Error('injected persistence failure');

    await assert.rejects(
      runMongoTransaction(async () => {
        throw operationError;
      }, {
        connection: harness.connection,
      }),
      error => error === operationError,
    );
    assert.equal(harness.calls.endSession, 1);
  });

  test('session teardown failure does not turn a committed result into failure', async () => {
    const harness = makeConnection({
      endSession: async () => {
        throw new Error('injected teardown failure');
      },
    });

    const result = await runMongoTransaction(
      async () => 'committed',
      { connection: harness.connection },
    );

    assert.equal(result, 'committed');
    assert.equal(harness.calls.endSession, 1);
  });

  test('maps actual transaction-unavailable errors distinctly', async () => {
    const unavailable = Object.assign(
      new Error(
        'Transaction numbers are only allowed on a replica set member or mongos',
      ),
      { code: 20 },
    );
    const harness = makeConnection({
      withTransaction: async callback => {
        await callback();
        throw unavailable;
      },
    });

    await assert.rejects(
      runMongoTransaction(async () => 'not committed', {
        connection: harness.connection,
      }),
      error => {
        assert.ok(error instanceof MongoTransactionUnavailableError);
        assert.equal(error.code, MONGO_TRANSACTION_UNAVAILABLE);
        assert.equal(error.originalError, unavailable);
        assert.equal(error.cause, unavailable);
        return true;
      },
    );
    assert.equal(harness.calls.endSession, 1);
  });

  test('maps start-session setup failure and performs no fallback work', async () => {
    const setupError = new Error('session setup failed');
    let workCalls = 0;
    const connection = {
      async startSession() {
        throw setupError;
      },
    };

    await assert.rejects(
      runMongoTransaction(async () => {
        workCalls += 1;
      }, { connection }),
      error => {
        assert.equal(error.code, MONGO_TRANSACTION_UNAVAILABLE);
        assert.equal(error.originalError, setupError);
        assert.equal(error.stage, 'start-session');
        return true;
      },
    );
    assert.equal(workCalls, 0);
  });

  test('does not run work outside withTransaction when transaction setup is invalid', async () => {
    let workCalls = 0;
    let endCalls = 0;
    const connection = {
      async startSession() {
        return {
          async endSession() {
            endCalls += 1;
          },
        };
      },
    };

    await assert.rejects(
      runMongoTransaction(async () => {
        workCalls += 1;
      }, { connection }),
      error => error.code === MONGO_TRANSACTION_UNAVAILABLE,
    );
    assert.equal(workCalls, 0);
    assert.equal(endCalls, 1);
  });
});
