// Shared constants and helpers for every extension context.
// Pages load this via a script tag before their own script; the Chrome service
// worker uses importScripts; Firefox lists it first in background.scripts.

const api = typeof browser !== 'undefined' ? browser : chrome;
const IS_FIREFOX =
  typeof browser !== 'undefined' && browser.runtime.getURL('').startsWith('moz-extension://');

const DEFAULT_BYPASS = ['127.0.0.1', '<local>'];
const DEFAULT_STATE = {
  proxies: [],
  activeId: null,
  enabled: false,
  checkResults: {},
  routingDefault: 'proxy',
  routingRules: null
};

const ROUTING_ACTIONS = ['direct', 'proxy', 'block'];

function normalizePatterns(patterns) {
  return Array.isArray(patterns)
    ? patterns.map((pattern) => String(pattern).trim()).filter(Boolean)
    : [];
}

// IPv6 literals are stored bare and need brackets wherever they sit in a URL,
// a PAC directive, or a host:port string the user can edit.
function bracketHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function canonicalProxyHost(host) {
  if (typeof host !== 'string') return null;
  const value = host.trim();
  if (!value || /[\s/?#@[\]*]/.test(value)) return null;
  const authority = bracketHost(value);
  try {
    const parsed = new URL(`http://${authority}:1/`);
    const normalized = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return parsed.port === '1' && normalized ? normalized : null;
  } catch {
    return null;
  }
}

function isValidProxyHost(host) {
  return canonicalProxyHost(host) !== null;
}

function normalizeRoutingHostPattern(value) {
  let prefix = '';
  if (value.startsWith('*.')) prefix = '*.';
  else if (value.startsWith('.')) prefix = '.';

  const rawHost = value.slice(prefix.length);
  const bracketed = rawHost.match(/^\[([^\]]+)\]$/);
  const host = canonicalProxyHost(bracketed ? bracketed[1] : rawHost);
  if (!host || (prefix && host.includes(':'))) return null;
  return prefix + bracketHost(host);
}

function normalizeRoutingPattern(value) {
  if (typeof value !== 'string') return null;
  const pattern = value.trim();
  if (pattern === '<local>') return pattern;

  if (pattern.includes('://')) {
    const match = pattern.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(\/[^#]*)?$/i);
    if (!match) return null;
    const host = normalizeRoutingHostPattern(match[2]);
    if (!host) return null;
    return `${match[1].toLowerCase()}://${host}${match[3] || '/*'}`;
  }

  return normalizeRoutingHostPattern(pattern);
}

// ---------------------------------------------------------------------------
// Stored records. The background is the only writer, but both it and the
// options page build records, so the shape and its normalization live here.
// ---------------------------------------------------------------------------

// Whitelists stored fields, so caller-supplied extras (including forged
// revisions) can never reach storage. Idempotent: re-running it on an
// already-normalized record is a no-op, so the background can apply it again
// to whatever a page sent.
function makeProxy({ id, label = '', scheme, host, port, username = '', password = '' }) {
  return {
    id: id || crypto.randomUUID(),
    label: label.trim(),
    scheme: scheme || 'http',
    host: canonicalProxyHost(host) || String(host).trim(),
    port: Number(port),
    username: username.trim(),
    password
  };
}

function hasValidProxyEndpoint(proxy) {
  if (!proxy || !isValidProxyHost(proxy.host)) return false;
  const port = Number(proxy.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// A duplicate proxy has the same connection endpoint and credentials. Labels
// are intentionally excluded so renaming a proxy cannot create a duplicate.
function proxyKey(proxy) {
  return JSON.stringify([
    String(proxy?.scheme || 'http').toLowerCase(),
    canonicalProxyHost(proxy?.host) || String(proxy?.host || '').trim().toLowerCase(),
    Number(proxy?.port),
    String(proxy?.username || ''),
    String(proxy?.password || '')
  ]);
}

function proxyHostPort(proxy) {
  return `${bracketHost(proxy.host)}:${Number(proxy.port)}`;
}

// Optimistic concurrency token for edits; absent or malformed means 0.
function proxyRevision(proxy) {
  return Number.isInteger(proxy.revision) && proxy.revision >= 0 ? proxy.revision : 0;
}

function normalizeRoutingDefault(value) {
  return value === 'direct' ? 'direct' : 'proxy';
}

// Drops unparseable rules and mints ids for rules missing one. Callers that
// only read (the options list) must not use this: minting an id client-side
// would make later mutations address a rule the background does not have.
function normalizeRoutingRules(rules) {
  if (!Array.isArray(rules)) return [];
  const normalized = [];
  const ids = new Set();
  for (const rule of rules) {
    const pattern = normalizeRoutingPattern(rule && rule.pattern);
    if (!pattern || !ROUTING_ACTIONS.includes(rule.action)) continue;
    let id = typeof rule.id === 'string' ? rule.id : '';
    if (!id || ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    normalized.push({ id, pattern, action: rule.action });
  }
  return normalized;
}

function displayName(proxy) {
  return proxy.label || proxy.host;
}

// Check results are {pending, at} | {ok, ms, at} | {ok:false, error, at}.
function checkStateClass(proxy) {
  if (proxy.lastCheck?.ok) return ' verified';
  return proxy.lastCheck && !proxy.lastCheck.pending ? ' check-error' : '';
}

function attachCheckResults(proxies, checkResults) {
  const results =
    checkResults && typeof checkResults === 'object' && !Array.isArray(checkResults)
      ? checkResults
      : {};
  return proxies.map((proxy) =>
    Object.prototype.hasOwnProperty.call(results, proxy.id)
      ? { ...proxy, lastCheck: results[proxy.id] }
      : proxy
  );
}

// Every page mutation goes through the background; a dead background (reload
// or update) resolves null rather than rejecting, and callers resync.
function sendMessage(msg) {
  return api.runtime.sendMessage(msg).catch(() => null);
}
