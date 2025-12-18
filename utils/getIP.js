export const getIP = async (req, opts = {}) => {
  const { trustedProxies = [], allowPrivate = false } = opts;
  const candidates = getAllCandidateIps(req);

  for (const ip of candidates) {
    if (!ip) continue;
    if (!allowPrivate && isPrivateIp(ip)) continue;
    if (isTrustedProxy(ip, trustedProxies)) continue;
    return ip;
  }

  return null;
};


function getAllCandidateIps(req) {
  const headers = req.headers || {};
  const list = [];

  // 1) X-Forwarded-For (may be CSV: client, proxy1, proxy2)
  const xff = headers['x-forwarded-for'];
  if (xff) {
    // split and normalize, XFF is usually client-first
    for (const part of String(xff).split(',')) {
      const ip = normalizeIp(part);
      if (ip) list.push(ip);
    }
  }

  // 2) Forwarded (RFC 7239) e.g. Forwarded: for=192.0.2.43, for="[2001:db8::1]"
  const fwd = headers['forwarded'];
  if (fwd) {
    // extract all for= tokens
    const rx = /for=(?:"?\[?([^"\]]+)\]?"?)/gi;
    let m;
    while ((m = rx.exec(fwd))) {
      const ip = normalizeIp(m[1]);
      if (ip) list.push(ip);
    }
  }

  // 3) Other common headers (some CDNs / proxies)
  const prefer = [
    'x-real-ip',
    'cf-connecting-ip',
    'true-client-ip',
    'x-client-ip',
    'x-cluster-client-ip'
  ];
  for (const h of prefer) {
    const v = headers[h];
    if (v) {
      const ip = normalizeIp(v);
      if (ip) list.push(ip);
    }
  }

  // 4) Socket/connection addresses as last-resort
  // Different Node versions/hosting env use different props
  const remoteAddrs = [
    req.connection && req.connection.remoteAddress,
    req.socket && req.socket.remoteAddress,
    req.connection && req.connection.socket && req.connection.socket.remoteAddress,
    req.info && req.info.remoteAddress, // some frameworks/cloud
    req.remoteAddress // rare
  ];
  for (const a of remoteAddrs) {
    const ip = normalizeIp(a);
    if (ip) list.push(ip);
  }

  // dedupe while preserving order
  const seen = new Set();
  const out = [];
  for (const ip of list) {
    if (!seen.has(ip)) {
      seen.add(ip);
      out.push(ip);
    }
  }
  return out;
}

/* -------------------- Helpers -------------------- */

function normalizeIp(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // remove quotes
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);

  // IPv6 in brackets [::1]
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

  // remove port if present (IPv4: "1.2.3.4:54321", IPv6 with port "[::1]:1234")
  // already handled bracket form, but handle "127.0.0.1:8080"
  const colonPort = s.lastIndexOf(':');
  // naive check - if more than one colon likely an IPv6 literal; only strip port if there's only one colon (IPv4) or if it's IPv6 with brackets (handled above)
  if (colonPort !== -1 && s.indexOf(':') === s.lastIndexOf(':')) {
    // single colon -> probably host:port
    const maybePort = s.slice(colonPort + 1);
    if (/^\d+$/.test(maybePort)) {
      s = s.slice(0, colonPort);
    }
  }

  // IPv4 mapped IPv6 ::ffff:127.0.0.1 -> 127.0.0.1
  const v4mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/i);
  if (v4mapped) return v4mapped[1];

  // final sanity check basic pattern (ipv4 or ipv6)
  if (isIPv4(s) || isIPv6(s)) return s;
  return null;
}

function isIPv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}
function isIPv6(ip) {
  // basic IPv6 test (doesn't validate every nuance)
  return /^[0-9a-f:]+$/i.test(ip) && ip.indexOf(':') !== -1;
}

function isPrivateIp(ip) {
  if (!ip) return false;
  if (isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 169 && b === 254) return true; // link local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    return false;
  } else {
    // IPv6 checks: loopback ::1, unique local fc00::/7, link-local fe80::/10
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    if (lower.startsWith('fe80:')) return true; // fe80::/10 (approx)
    return false;
  }
}

function isTrustedProxy(ip, trustedProxies = []) {
  if (!trustedProxies || trustedProxies.length === 0) return false;
  for (const t of trustedProxies) {
    if (!t) continue;
    // exact match
    if (ip === t) return true;
    // IPv4 CIDR like "10.0.0.0/8"
    if (t.includes('/')) {
      if (isIPv4(ip) && cidrContains(t, ip)) return true;
    } else {
      // IPv6 simple prefix match (user can pass "fd00:" to match fd00::/8 etc)
      if (isIPv6(ip) && ip.startsWith(t)) return true;
    }
  }
  return false;
}

/**
 * cidrContains(cidr, ip)
 * Very small IPv4 CIDR check (expects valid IPv4 and an x.x.x.x/n cidr)
 */
function cidrContains(cidr, ip) {
  if (!cidr || !ip) return false;
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!isIPv4(net) || !isIPv4(ip) || Number.isNaN(bits)) return false;

  const netParts = net.split('.').map(Number);
  const ipParts = ip.split('.').map(Number);

  const netNum = ((netParts[0] << 24) >>> 0) + (netParts[1] << 16) + (netParts[2] << 8) + netParts[3];
  const ipNum  = ((ipParts[0] << 24) >>> 0) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (netNum & mask) === (ipNum & mask);
}

