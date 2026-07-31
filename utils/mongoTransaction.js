import mongoose from 'mongoose';

export const MONGO_TRANSACTION_UNAVAILABLE =
  'MONGO_TRANSACTION_UNAVAILABLE';

export const DEFAULT_TRANSACTION_OPTIONS = Object.freeze({
  readPreference: 'primary',
  readConcern: Object.freeze({ level: 'snapshot' }),
  writeConcern: Object.freeze({ w: 'majority' }),
});

const TRANSACTION_UNAVAILABLE_MESSAGES = [
  /transaction numbers are only allowed on a replica set member or mongos/iu,
  /transactions? (?:are|is) not supported/iu,
  /does not support transactions/iu,
];

export class MongoTransactionUnavailableError extends Error {
  constructor(cause, stage = 'transaction') {
    super('MongoDB transactions are unavailable.', { cause });
    this.name = 'MongoTransactionUnavailableError';
    this.code = MONGO_TRANSACTION_UNAVAILABLE;
    this.stage = stage;
    this.originalError = cause;
  }
}

export function isTransactionUnavailableError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof MongoTransactionUnavailableError) return true;

  const message = typeof error.message === 'string' ? error.message : '';
  return TRANSACTION_UNAVAILABLE_MESSAGES.some(pattern =>
    pattern.test(message)
  );
}

export async function runMongoTransaction(
  work,
  {
    connection = mongoose.connection,
    transactionOptions = DEFAULT_TRANSACTION_OPTIONS,
    unavailableErrorMatcher = isTransactionUnavailableError,
  } = {},
) {
  if (typeof work !== 'function') {
    throw new TypeError('Transaction work must be a function.');
  }

  let session;
  try {
    session = await connection.startSession();
  } catch (error) {
    throw new MongoTransactionUnavailableError(error, 'start-session');
  }

  if (!session || typeof session.withTransaction !== 'function') {
    try {
      await session?.endSession?.();
    } catch {
      // There is no operation error to mask; the setup error below is stable.
    }
    throw new MongoTransactionUnavailableError(
      new Error('MongoDB session does not support transactions.'),
      'start-session',
    );
  }

  let callbackResult;

  try {
    await session.withTransaction(async () => {
      callbackResult = await work(session);
      return callbackResult;
    }, transactionOptions);
    return callbackResult;
  } catch (error) {
    if (error instanceof MongoTransactionUnavailableError) throw error;
    if (unavailableErrorMatcher(error)) {
      throw new MongoTransactionUnavailableError(error);
    }
    throw error;
  } finally {
    try {
      await session.endSession();
    } catch {
      // Session teardown cannot change an already committed transaction result
      // or replace the original operation error.
    }
  }
}
