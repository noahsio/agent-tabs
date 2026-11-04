// Pure IPv4/IPv6 helpers for the guard: literal detection, CIDR parsing/matching, private-range test.
import { isIPv4, isIPv6 } from "node:net";

const parseV4 = (text) => text.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);

function parseV6(text) {
  let rest = text.split("%")[0];
  if (rest.includes(".")) {
    const cut = rest.lastIndexOf(":") + 1;
    const tail = parseV4(rest.slice(cut));
    rest = `${rest.slice(0, cut)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
  }
  const [head, tail] = rest.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array(fill).fill("0"), ...tailGroups];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

/** Parses an IPv4/IPv6 literal; returns { family, value } or null. */
export function parseIp(text) {
  if (typeof text !== "string") return null;
  if (isIPv4(text)) return { family: 4, value: parseV4(text) };
  const bare = text.split("%")[0];
  if (isIPv6(bare)) return { family: 6, value: parseV6(text) };
  return null;
}

/** Parses "ip" or "ip/len"; returns { family, value, length } or null. */
export function parseCidr(text) {
  if (typeof text !== "string") return null;
  const [address, lengthText, ...extra] = text.split("/");
  if (extra.length > 0) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const width = ip.family === 4 ? 32 : 128;
  if (lengthText === undefined) return { ...ip, length: width };
  if (!/^\d{1,3}$/.test(lengthText) || Number(lengthText) > width) return null;
  return { ...ip, length: Number(lengthText) };
}

export function cidrContains(cidr, ip) {
  if (cidr.family !== ip.family) return false;
  const shift = BigInt((cidr.family === 4 ? 32 : 128) - cidr.length);
  return cidr.value >> shift === ip.value >> shift;
}

const PRIVATE = [
  "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "0.0.0.0/32",
  "::1/128", "::/128", "fc00::/7", "fe80::/10",
].map(parseCidr);
const V4_MAPPED = parseCidr("::ffff:0:0/96");

export function isPrivateIp(ip) {
  if (ip.family === 6 && cidrContains(V4_MAPPED, ip)) return isPrivateIp({ family: 4, value: ip.value & 0xffffffffn });
  return PRIVATE.some((range) => cidrContains(range, ip));
}

const V4_RE = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\w|\.\d)/g;
const V6_RE = /(?<![\w:./])[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?(?![\w:])/g;

/** All IPv4/IPv6 literals in text. Hostnames are deliberately not resolved. */
export function findIpLiterals(text) {
  const found = new Set(text.match(V4_RE) ?? []);
  for (const candidate of text.match(V6_RE) ?? []) {
    const trimmed = candidate.replace(/\.+$/, "");
    if ((trimmed.match(/:/g) ?? []).length >= 2 && isIPv6(trimmed.split("%")[0])) found.add(trimmed);
  }
  return [...found];
}

/** Public (non-private, non-loopback) literals not covered by the whitelist (array of parsed CIDRs). */
export function publicIpsOutside(text, whitelist) {
  return findIpLiterals(text).filter((literal) => {
    const ip = parseIp(literal);
    return ip && !isPrivateIp(ip) && !whitelist.some((cidr) => cidrContains(cidr, ip));
  });
}
