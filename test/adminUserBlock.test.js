import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import mongoose from 'mongoose';

import { createUserBlockHandler } from '../controllers/admin.js';
import { createLogger } from '../utils/logging.js';

const TARGET_ID = '64b7f2d4c9f1e8a123456789';
const ADMIN_ID = '74b7f2d4c9f1e8a123456789';
const MISSING_TARGET = Symbol('missing-target');

function createRecorder() {
  const logs = [];
  const redirects = [];
  return {
    logs,
    redirects,
    async log(...args) {
      logs.push(args);
    },
    redirectWithFlash(...args) {
      redirects.push(args);
      return { redirected: true };
    },
  };
}

function createModel({ result = null, error = null } = {}) {
  const calls = [];
  return {
    calls,
    model: {
      async findOneAndUpdate(...args) {
        calls.push(args);
        if (error) throw error;
        return result;
      },
    },
  };
}

function createRequest(id, administratorId = ADMIN_ID) {
  return {
    params: id === MISSING_TARGET ? {} : { id },
    user: { _id: administratorId },
  };
}

async function invoke({
  blocked,
  model,
  recorder,
  id = TARGET_ID,
  administratorId = ADMIN_ID,
}) {
  const req = createRequest(id, administratorId);
  const res = {};
  const handler = createUserBlockHandler({
    blocked,
    UserModel: model,
    log: recorder.log,
    redirectWithFlash: recorder.redirectWithFlash,
  });
  const result = await handler(req, res, () => {});
  return { req, res, result };
}

function assertFlash(recorder, req, res, type, message) {
  assert.deepEqual(recorder.redirects, [[
    req,
    res,
    type,
    message,
    '/a/dashboard',
  ]]);
}

for (const fixture of [
  {
    name: 'Block',
    blocked: true,
    successMessage: 'User has been blocked.',
    failureMessage: 'Failed to block user.',
    logMessage: 'Admin user block operation failed.',
  },
  {
    name: 'Unblock',
    blocked: false,
    successMessage: 'User has been unblocked.',
    failureMessage: 'Failed to unblock user.',
    logMessage: 'Admin user unblock operation failed.',
  },
]) {
  describe(`${fixture.name} administrator target handling`, () => {
    test('malformed and missing targets make zero database calls', async t => {
      for (const [name, id] of [
        ['malformed', 'malformed-attacker-target'],
        ['missing', MISSING_TARGET],
      ]) {
        await t.test(name, async () => {
          let databaseCalls = 0;
          const castError = new mongoose.Error.CastError(
            'ObjectId',
            id === MISSING_TARGET ? undefined : id,
            '_id',
          );
          const model = new Proxy({}, {
            get() {
              return async () => {
                databaseCalls += 1;
                throw castError;
              };
            },
          });
          const recorder = createRecorder();
          const { req, res, result } = await invoke({
            blocked: fixture.blocked,
            model,
            recorder,
            id,
          });

          assert.deepEqual(result, { redirected: true });
          assert.equal(databaseCalls, 0);
          assert.equal(recorder.logs.length, 0);
          assertFlash(
            recorder,
            req,
            res,
            'error',
            'Invalid user target.',
          );
          assert.doesNotMatch(
            JSON.stringify(recorder.redirects[0].slice(2)),
            /malformed-attacker-target|CastError/u,
          );
        });
      }
    });

    test('self-targeting with ObjectId or string IDs makes zero database calls', async () => {
      const modelState = createModel();

      for (const administratorId of [
        new mongoose.Types.ObjectId(TARGET_ID),
        TARGET_ID.toUpperCase(),
      ]) {
        const recorder = createRecorder();
        const { req, res } = await invoke({
          blocked: fixture.blocked,
          model: modelState.model,
          recorder,
          administratorId,
        });

        assert.equal(recorder.logs.length, 0);
        assertFlash(
          recorder,
          req,
          res,
          'error',
          'You cannot change your own blocked status.',
        );
      }

      assert.equal(modelState.calls.length, 0);
    });

    test('a valid target performs exactly one restrictive atomic update', async () => {
      const updated = {
        _id: new mongoose.Types.ObjectId(TARGET_ID),
        blocked: fixture.blocked,
      };
      const modelState = createModel({ result: updated });
      const recorder = createRecorder();
      const { req, res, result } = await invoke({
        blocked: fixture.blocked,
        model: modelState.model,
        recorder,
      });

      assert.deepEqual(result, { redirected: true });
      assert.equal(modelState.calls.length, 1);
      const [filter, update, options] = modelState.calls[0];
      assert.deepEqual(Object.keys(filter), ['_id']);
      assert.ok(filter._id instanceof mongoose.Types.ObjectId);
      assert.equal(filter._id.toHexString(), TARGET_ID);
      assert.deepEqual(update, { $set: { blocked: fixture.blocked } });
      assert.deepEqual(options, {
        new: true,
        runValidators: true,
        projection: { _id: 1, blocked: 1 },
        upsert: false,
      });
      assert.equal(recorder.logs.length, 0);
      assertFlash(
        recorder,
        req,
        res,
        'success',
        fixture.successMessage,
      );
    });

    test('a nonexistent valid target receives an error without logging', async () => {
      const modelState = createModel({ result: null });
      const recorder = createRecorder();
      const { req, res, result } = await invoke({
        blocked: fixture.blocked,
        model: modelState.model,
        recorder,
      });

      assert.deepEqual(result, { redirected: true });
      assert.equal(modelState.calls.length, 1);
      assert.equal(recorder.logs.length, 0);
      assertFlash(
        recorder,
        req,
        res,
        'error',
        'User was not found.',
      );
    });

    test('a database CastError keeps fixed safe failure output', async () => {
      const fakeFilter = `fixture-filter-{_id:${TARGET_ID}}`;
      const databaseValue = 'fixture-private-database-value';
      const arbitraryErrorValue = 'fixture-arbitrary-error-property';
      const causeMessage = 'fixture-private-database-cause';
      const castError = new mongoose.Error.CastError(
        'ObjectId',
        TARGET_ID,
        '_id',
      );
      castError.message =
        `fixture database message ${TARGET_ID} ${fakeFilter} ` +
        databaseValue;
      castError.stack =
        `MongoServerError: ${castError.message}\n` +
        `    at fixture query ${fakeFilter}`;
      castError.code = `FIXTURE_CODE_${databaseValue}`;
      castError.cause = new Error(causeMessage);
      castError.filter = fakeFilter;
      castError.arbitraryDatabaseProperty = arbitraryErrorValue;

      const modelState = createModel({ error: castError });
      const recorder = createRecorder();
      const controllerLogCalls = [];
      const completedLogEntries = [];
      const fallbackOutputs = [];
      const safeLogger = createLogger({
        errorOutput: entry => completedLogEntries.push(entry),
        normalOutput: entry => completedLogEntries.push(entry),
        fallbackOutput: output => fallbackOutputs.push(output),
      });
      recorder.log = async (...args) => {
        controllerLogCalls.push(args);
        await safeLogger(...args);
      };
      const { req, res, result } = await invoke({
        blocked: fixture.blocked,
        model: modelState.model,
        recorder,
      });

      assert.deepEqual(result, { redirected: true });
      assert.equal(modelState.calls.length, 1);
      assert.equal(controllerLogCalls.length, 1);
      assert.equal(controllerLogCalls[0][0], req);
      assert.equal(controllerLogCalls[0][1], res);
      assert.equal(controllerLogCalls[0][2], 'error');
      assert.deepEqual(controllerLogCalls[0][3], {
        message: fixture.logMessage,
      });
      assert.equal(
        Object.hasOwn(controllerLogCalls[0][3], 'error'),
        false,
      );
      assert.deepEqual(completedLogEntries, [{
        type: 'error',
        message: fixture.logMessage,
        authenticatedUserId: ADMIN_ID,
      }]);
      assert.equal(Object.hasOwn(completedLogEntries[0], 'error'), false);
      assert.deepEqual(fallbackOutputs, []);
      assertFlash(
        recorder,
        req,
        res,
        'error',
        fixture.failureMessage,
      );

      const completedLogOutput = JSON.stringify(completedLogEntries);
      const visibleFlashOutput = JSON.stringify(
        recorder.redirects[0].slice(2),
      );
      assert.ok(completedLogOutput.includes(fixture.logMessage));
      for (const sensitiveValue of [
        TARGET_ID,
        fakeFilter,
        castError.message,
        castError.stack,
        castError.name,
        castError.code,
        causeMessage,
        databaseValue,
        'arbitraryDatabaseProperty',
        arbitraryErrorValue,
      ]) {
        assert.equal(
          completedLogOutput.includes(sensitiveValue),
          false,
          `completed log contained ${sensitiveValue}`,
        );
      }
      assert.doesNotMatch(visibleFlashOutput, /CastError/u);
      assert.doesNotMatch(visibleFlashOutput, new RegExp(TARGET_ID, 'u'));
    });
  });
}
