export const DEFAULT_BOT_BLOCK_DURATION_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_BOT_BLOCK_MAX_ENTRIES = 5_000;

const MAX_CLIENT_ID_LENGTH = 128;

function normalizeClientId(clientId) {
  if (typeof clientId !== 'string') return null;
  const normalized = clientId.trim();
  if (!normalized || normalized.length > MAX_CLIENT_ID_LENGTH) return null;
  return normalized;
}

/**
 * A bounded, process-local block cache. It resets when the process restarts and
 * does not coordinate blocks between application instances.
 */
export class BlockedClientCache {
  #entries = new Map();
  #sequence = 0;

  constructor({
    blockDurationMs = DEFAULT_BOT_BLOCK_DURATION_MS,
    maxEntries = DEFAULT_BOT_BLOCK_MAX_ENTRIES,
    clock = Date.now,
  } = {}) {
    if (!Number.isFinite(blockDurationMs) || blockDurationMs <= 0) {
      throw new TypeError('blockDurationMs must be a positive finite number.');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError('maxEntries must be a positive safe integer.');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function.');
    }

    this.blockDurationMs = blockDurationMs;
    this.maxEntries = maxEntries;
    this.clock = clock;
  }

  get size() {
    return this.#entries.size;
  }

  isBlocked(clientId) {
    const key = normalizeClientId(clientId);
    if (!key) return false;

    const entry = this.#entries.get(key);
    if (!entry) return false;

    const now = this.#now();
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return false;
    }

    return true;
  }

  block(clientId) {
    const key = normalizeClientId(clientId);
    if (!key) return false;

    const now = this.#now();
    this.pruneExpired(now);

    const expiresAt = now + this.blockDurationMs;
    const existing = this.#entries.get(key);
    if (existing) {
      existing.expiresAt = expiresAt;
      return true;
    }

    if (this.#entries.size >= this.maxEntries) {
      this.#evictOldestExpiring();
    }

    this.#entries.set(key, {
      expiresAt,
      sequence: this.#sequence,
    });
    this.#sequence += 1;
    return true;
  }

  pruneExpired(now = this.#now()) {
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  #now() {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      throw new TypeError('clock must return a finite number.');
    }
    return now;
  }

  #evictOldestExpiring() {
    let evictionKey;
    let evictionEntry;

    for (const [key, entry] of this.#entries) {
      if (
        !evictionEntry ||
        entry.expiresAt < evictionEntry.expiresAt ||
        (
          entry.expiresAt === evictionEntry.expiresAt &&
          entry.sequence < evictionEntry.sequence
        )
      ) {
        evictionKey = key;
        evictionEntry = entry;
      }
    }

    if (evictionKey !== undefined) this.#entries.delete(evictionKey);
  }
}
