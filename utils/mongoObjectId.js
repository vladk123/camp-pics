import mongoose from 'mongoose';

const STRICT_OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/u;

const INVALID_OBJECT_ID_RESULT = Object.freeze({
  valid: false,
  stringValue: null,
  objectId: null,
});

export function parseStrictMongoObjectId(value) {
  if (
    typeof value !== 'string' ||
    !STRICT_OBJECT_ID_PATTERN.test(value)
  ) {
    return INVALID_OBJECT_ID_RESULT;
  }

  try {
    const objectId = new mongoose.Types.ObjectId(value);
    return Object.freeze({
      valid: true,
      stringValue: objectId.toHexString(),
      objectId,
    });
  } catch {
    return INVALID_OBJECT_ID_RESULT;
  }
}

function getStrictObjectIdString(value) {
  try {
    if (typeof value === 'string') return value;
    if (
      value == null ||
      (typeof value !== 'object' && typeof value !== 'function')
    ) {
      return null;
    }

    const toHexString = value.toHexString;
    if (typeof toHexString === 'function') {
      return toHexString.call(value);
    }

    const toString = value.toString;
    if (
      typeof toString === 'function' &&
      toString !== Object.prototype.toString
    ) {
      return toString.call(value);
    }
  } catch {
    return null;
  }

  return null;
}

export function strictMongoObjectIdsEqual(validatedTargetId, candidateId) {
  const targetString = getStrictObjectIdString(validatedTargetId);
  const candidateString = getStrictObjectIdString(candidateId);

  return (
    typeof targetString === 'string' &&
    typeof candidateString === 'string' &&
    STRICT_OBJECT_ID_PATTERN.test(targetString) &&
    STRICT_OBJECT_ID_PATTERN.test(candidateString) &&
    targetString.toLowerCase() === candidateString.toLowerCase()
  );
}
