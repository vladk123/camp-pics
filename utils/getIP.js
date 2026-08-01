import { isIP } from 'node:net';

const IPV4_MAPPED_IPV6 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * Return only Express's canonical client address after its trust-proxy policy.
 * Raw forwarding headers are intentionally never inspected here.
 */
export function getIP(req) {
  let expressIp;
  try {
    expressIp = req?.ip;
  } catch {
    return null;
  }

  if (typeof expressIp !== 'string') return null;
  const normalized = expressIp.trim();
  if (!normalized) return null;

  const mapped = normalized.match(IPV4_MAPPED_IPV6)?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;

  return isIP(normalized) ? normalized : null;
}
