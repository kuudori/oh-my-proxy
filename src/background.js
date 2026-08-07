// Oh My Proxy background (Chrome MV3 service worker / Firefox MV2 background page).
// Owns proxy settings, proxy auth, connectivity checks, and every state write.
// UI pages read storage.local directly but send mutations here as messages;
// the storage.onChanged listener below re-applies settings after every write,
// so no caller has to remember to.

// check-fetch.js is deliberately absent here: the Chrome worker never calls it
// (service worker fetches get no proxy auth challenges, so checks run in the
// offscreen worker, which imports it itself). Firefox loads it via manifest.
if (typeof importScripts === 'function') {
  importScripts('shared.js', 'routing.js', 'platform-chrome.js');
}

const action = api.action || api.browserAction;

// Both icon sets ship as files. The off variant is the on variant desaturated
// by luminance; regenerating it at runtime meant four fetches, four bitmap
// decodes and a full pixel pass on every worker wake, which is the common
// case because a sleeping worker wakes with the proxy off.
const ACTION_ICON_PATHS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png'
};

const ACTION_ICON_PATHS_OFF = {
  16: 'icons/icon16-off.png',
  32: 'icons/icon32-off.png',
  48: 'icons/icon48-off.png',
  128: 'icons/icon128-off.png'
};

function setActionIcon(enabled) {
  return action.setIcon({ path: enabled ? ACTION_ICON_PATHS : ACTION_ICON_PATHS_OFF });
}

const CHECK_URL = 'https://example.com/';
const CHECK_TIMEOUT_MS = 12000;
const CHECK_ERRORS = {
  timeout: 'Timed out',
};

let migrationPromise = null;

// True when normalization left every canonical field untouched, so there is
// nothing to heal. Cheaper than serializing the rules twice on every read.
function routingRulesUnchanged(normalized, stored) {
  return (
    normalized.length === stored.length &&
    normalized.every((rule, index) => {
      const before = stored[index];
      return (
        before &&
        rule.id === before.id &&
        rule.pattern === before.pattern &&
        rule.action === before.action
      );
    })
  );
}

// The single normalization boundary: everything downstream may assume
// routingRules is canonical and routingDefault is one of the two literals.
async function getState() {
  const state = await api.storage.local.get(DEFAULT_STATE);
  let checkResults =
    state.checkResults && typeof state.checkResults === 'object' && !Array.isArray(state.checkResults)
      ? { ...state.checkResults }
      : {};
  let proxies = Array.isArray(state.proxies) ? state.proxies : [];
  let migratedChecks = false;
  proxies = proxies.map((proxy) => {
    if (!proxy || !proxy.lastCheck) return proxy;
    checkResults = { ...checkResults, [proxy.id]: proxy.lastCheck };
    const { lastCheck: _lastCheck, ...record } = proxy;
    migratedChecks = true;
    return record;
  });
  if (migratedChecks) await api.storage.local.set({ proxies, checkResults });
  state.proxies = proxies;
  state.checkResults = checkResults;

  if (Array.isArray(state.routingRules)) {
    const routingRules = normalizeRoutingRules(state.routingRules);
    if (!routingRulesUnchanged(routingRules, state.routingRules)) {
      await api.storage.local.set({ routingRules });
    }
    return {
      ...state,
      routingRules,
      routingDefault: normalizeRoutingDefault(state.routingDefault)
    };
  }

  if (!migrationPromise) {
    migrationPromise = (async () => {
      const legacy = await api.storage.local.get({
        bypass: DEFAULT_BYPASS,
        targets: [],
        targetEnabled: false
      });
      const routingRules = normalizeRoutingRules([
        ...normalizePatterns(legacy.bypass).map((pattern) => ({ pattern, action: 'direct' })),
        ...normalizePatterns(legacy.targets).map((pattern) => ({ pattern, action: 'proxy' }))
      ]);
      await api.storage.local.set({
        routingDefault: legacy.targetEnabled ? 'direct' : 'proxy',
        routingRules
      });
      await api.storage.local.remove(['bypass', 'targets', 'targetEnabled']);
    })();
  }
  await migrationPromise;
  return getState();
}

// The proxy being checked right now, or null. Module state is enough: the
// Firefox background page is persistent, and Chrome keeps the worker alive
// while the check is in flight. If the worker still dies mid check, the top
// level init call below re-applies saved state and scrubs the pending flag.
let activeCheck = null;
let checkingDirect = false;

// ---------------------------------------------------------------------------
// Background state writes. Every write from this file goes through
// mutateState, one at a time, so overlapping read-modify-write cycles (check
// results, scrubs, toggles, shortcuts) can not clobber each other. The
// callback gets fresh state and returns the keys to write, or null to skip.
// ---------------------------------------------------------------------------

let writeQueue = Promise.resolve();

function mutateState(fn) {
  const run = writeQueue.then(async () => {
    const updates = fn(await getState());
    if (updates) await api.storage.local.set(updates);
    return updates;
  });
  writeQueue = run.catch(() => {});
  return run;
}

// Single owner of the activation policy: turning on with nothing selected
// picks the first proxy, turning on with no proxies saved is refused.
function enabledUpdates({ proxies, activeId }, on) {
  if (on && proxies.length === 0) return null;
  const updates = { enabled: on };
  if (on && !proxies.some((p) => p.id === activeId)) updates.activeId = proxies[0].id;
  return updates;
}

async function setEnabled(on) {
  return Boolean(await mutateState((state) => enabledUpdates(state, on)));
}

// ---------------------------------------------------------------------------
// Applying routing rules. Browser-specific proxy APIs live in the platform
// adapters; background.js owns state, action UI, and apply serialization.
// ---------------------------------------------------------------------------

let appliedConfigSignature = null;

function configSignature(state, proxy, active) {
  return JSON.stringify({
    active,
    proxy: active
      ? {
          id: proxy.id,
          label: proxy.label,
          scheme: proxy.scheme,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password
        }
      : null,
    routingRules: state.routingRules,
    routingDefault: state.routingDefault
  });
}

async function applyFromState() {
  const state = await getState();
  const proxy = state.proxies.find((item) => item.id === state.activeId);

  // Heal state a lost race can leave behind, for example toggling on while
  // the active proxy was deleted or invalidated in another page.
  if (state.enabled && (!proxy || !hasValidProxyEndpoint(proxy))) {
    await mutateState(() => ({ enabled: false, activeId: null }));
    return;
  }

  const active = Boolean(state.enabled && proxy);
  if (active && !(await platformAdapter.controllable())) {
    appliedConfigSignature = null;
    await Promise.all([
      action.setBadgeText({ text: '!' }),
      setActionIcon(false),
      action.setTitle({ title: 'Oh My Proxy: Controlled by another extension' }),
      platformAdapter.applySavedConfig({
        active: false,
        proxy: null,
        routingRules: [],
        routingDefault: state.routingDefault
      })
    ]);
    return;
  }

  const signature = configSignature(state, proxy, active);
  if (signature === appliedConfigSignature) return;
  await Promise.all([
    action.setBadgeText({ text: active ? 'ON' : '' }),
    setActionIcon(active),
    action.setTitle({
      title: active ? `Oh My Proxy: ${displayName(proxy)}` : 'Oh My Proxy: Off'
    }),
    platformAdapter.applySavedConfig({
      active,
      proxy,
      routingRules: state.routingRules,
      routingDefault: state.routingDefault
    })
  ]);
  appliedConfigSignature = signature;
}

// While a check runs it owns the proxy settings: first the direct phase,
// then the checked proxy. Everything, including the check's own phase
// switches, applies settings through the same serialized queue, so a slow
// apply can never land after a newer one and leave stale settings in effect.
async function applyCurrent() {
  if (!checkingDirect && !activeCheck) {
    await applyFromState();
    return;
  }
  appliedConfigSignature = null;
  await platformAdapter.applyCheckConfig({ checkingDirect, activeCheck });
}

let applyQueue = Promise.resolve();

function scheduleApply() {
  applyQueue = applyQueue.then(applyCurrent).catch(() => {});
  return applyQueue;
}

// Single reaction point: any state write from any page re-applies the proxy.
const APPLIED_STATE_KEYS = new Set([
  'enabled',
  'activeId',
  'proxies',
  'routingRules',
  'routingDefault'
]);

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.proxies) credentialCache = null;
  if (!Object.keys(changes).some((key) => APPLIED_STATE_KEYS.has(key))) return;
  platformAdapter.onStorageChanged(changes);
  scheduleApply();
});

// ---------------------------------------------------------------------------
// Proxy authentication (HTTP/HTTPS proxies; Firefox SOCKS auth is passed in
// ProxyInfo above; Chromium does not support SOCKS auth at all).
// Credentials are matched against the challenger (host:port of the proxy that
// asked), so this also covers the temporary proxy used during a check.
// ---------------------------------------------------------------------------

// Hostnames are case insensitive and IPv6 literals may arrive bracketed.
function normalizeHost(value) {
  return String(value).toLowerCase().replace(/^\[|\]$/g, '');
}

let credentialCache = null;

function credentialKey(host, port) {
  return `${normalizeHost(host)}:${Number(port)}`;
}

async function findCredentials(challenger) {
  const key = credentialKey(challenger.host, challenger.port);
  if (activeCheck && activeCheck.username && credentialKey(activeCheck.host, activeCheck.port) === key) {
    return { username: activeCheck.username, password: activeCheck.password || '' };
  }
  if (!credentialCache) {
    const { proxies } = await getState();
    credentialCache = new Map(
      proxies
        .filter((proxy) => proxy.username)
        .map((proxy) => [
          credentialKey(proxy.host, proxy.port),
          { username: proxy.username, password: proxy.password || '' }
        ])
    );
  }
  return credentialCache.get(key) || null;
}

// Guard against an infinite auth loop when saved credentials are wrong:
// answer the challenge once per request, then cancel. Requests we never
// answered are left alone so the browser's own login prompt keeps working;
// marking those too would cancel the user's retry after one wrong attempt.
// Entries are pruned by age on each challenge. Chrome mirrors them to
// storage.session so the guard survives service worker restarts; Firefox's
// background page is persistent and keeps the module copy.
const ANSWERED_TTL_MS = 60000;
let answeredAuth = {};
const answeredAuthLoaded = platformAdapter
  .loadAnsweredAuth()
  .then((stored) => {
    answeredAuth = { ...stored, ...answeredAuth };
  })
  .catch(() => {});

function pruneAnswered() {
  const cutoff = Date.now() - ANSWERED_TTL_MS;
  for (const id of Object.keys(answeredAuth)) {
    if (answeredAuth[id] < cutoff) delete answeredAuth[id];
  }
}

function persistAnswered() {
  platformAdapter.saveAnsweredAuth(answeredAuth);
}

async function authDecision(details) {
  if (!details.isProxy) return {};
  await answeredAuthLoaded;
  pruneAnswered();
  if (answeredAuth[details.requestId]) {
    delete answeredAuth[details.requestId];
    persistAnswered();
    return { cancel: true };
  }
  const creds = await findCredentials(details.challenger);
  if (!creds) return {};
  answeredAuth[details.requestId] = Date.now();
  persistAnswered();
  return { authCredentials: creds };
}

platformAdapter.start({
  getState,
  getCheckState: () => ({ activeCheck, checkingDirect }),
  authDecision
});

// ---------------------------------------------------------------------------
// Connectivity checks verify that a request can reach a fixed URL through the
// selected proxy and record response time only. Checks are serialized because
// proxying is browser-global. On Chrome the requests run in a worker inside an
// offscreen document: proxy auth challenges are not delivered for the service
// worker's own fetches (crbug.com/1371177), while worker requests do get them.
// Results are {pending, at} | {ok, ms, at} | {ok:false, error, at}.
// ---------------------------------------------------------------------------

function saveCheckResult(id, lastCheck, expectedRevision) {
  return mutateState(({ proxies, checkResults }) => {
    const proxy = proxies.find((item) => item.id === id);
    if (!proxy || (expectedRevision !== undefined && proxyRevision(proxy) !== expectedRevision)) {
      return null;
    }
    return { checkResults: { ...checkResults, [id]: lastCheck } };
  });
}


async function doCheck(proxy) {
  const revision = proxyRevision(proxy);
  if (!hasValidProxyEndpoint(proxy)) {
    const result = { ok: false, error: 'Invalid host or port', at: Date.now() };
    await saveCheckResult(proxy.id, result, revision);
    return result;
  }

  let result;
  try {
    if (!(await platformAdapter.controllable())) {
      result = { ok: false, error: 'Another extension controls the proxy' };
    } else {
      activeCheck = proxy;
      await scheduleApply();
      const fetched = await platformAdapter.checkFetch(CHECK_URL, CHECK_TIMEOUT_MS);
      if (!fetched || !fetched.ok) {
        throw new Error(fetched && fetched.error ? fetched.error : 'network');
      }
      result = { ok: true, ms: fetched.ms };
    }
  } catch (e) {
    const error = e.message?.startsWith('HTTP ')
      ? e.message
      : CHECK_ERRORS[e.message] || 'Connection failed';
    result = { ok: false, error };
  } finally {
    activeCheck = null;
    await scheduleApply();
  }
  result.at = Date.now();
  await saveCheckResult(proxy.id, result, revision);
  return result;
}

let checkQueue = Promise.resolve();

// The pending flag is written immediately so every queued row shows feedback
// at once. Checks resolve the proxy by id from current state when they
// actually run, so a queued check never tests a stale snapshot.
function enqueueCheck(id) {
  const run = checkQueue.then(async () => {
    const { proxies } = await getState();
    const proxy = proxies.find((item) => item.id === id);
    if (!proxy) return { ok: false, error: 'Proxy not found' };
    if (!(await saveCheckResult(id, { pending: true, at: Date.now() }))) {
      return { ok: false, error: 'Proxy not found' };
    }
    return doCheck(proxy);
  });
  checkQueue = run.catch(() => {});
  return run;
}

// Remove interrupted states and metadata from former IP lookup checks. Runs
// on every background start. The age cutoff on pending flags spares a check
// that was enqueued by the very event that woke this worker.
function scrubCheckResults() {
  return mutateState(({ proxies, checkResults }) => {
    const pendingCutoff = Date.now() - 5000;
    const proxyIds = new Set(proxies.map((proxy) => proxy.id));
    const cleaned = {};
    let changed = false;
    for (const [id, lastCheck] of Object.entries(checkResults)) {
      if (!proxyIds.has(id)) {
        changed = true;
        continue;
      }
      if (
        lastCheck == null ||
        (lastCheck.pending && (!lastCheck.at || lastCheck.at < pendingCutoff)) ||
        (lastCheck.ok && !Number.isFinite(lastCheck.ms))
      ) {
        changed = true;
        continue;
      }
      if (lastCheck.ok && ('ip' in lastCheck || 'country' in lastCheck || 'cc' in lastCheck)) {
        cleaned[id] = { ok: true, ms: lastCheck.ms, at: lastCheck.at };
        changed = true;
      } else {
        cleaned[id] = lastCheck;
      }
    }
    return changed ? { checkResults: cleaned } : null;
  });
}
// ---------------------------------------------------------------------------
// Messages from popup / options.
// ---------------------------------------------------------------------------

// Mutations that share one shape, keyed by message type. `apply` gets fresh
// state and returns the keys to write, or null to decline with `error`
// (default 'conflict'). An optional `accepts` rejects a malformed message
// before any state is read, answering 'invalid'.
const MUTATIONS = {
  setActive: {
    error: 'missing',
    apply: (state, msg) => (state.proxies.some((p) => p.id === msg.id) ? { activeId: msg.id } : null)
  },
  importProxies: {
    error: 'duplicate',
    accepts: (msg) => Array.isArray(msg.proxies) && msg.proxies.every(hasValidProxyEndpoint),
    apply: (state, msg) => {
      const proxies = msg.proxies.map((input) => ({ ...makeProxy(input), revision: 0 }));
      const keys = new Set(state.proxies.map(proxyKey));
      for (const proxy of proxies) {
        const key = proxyKey(proxy);
        if (keys.has(key)) return null;
        keys.add(key);
      }
      return { proxies: [...state.proxies, ...proxies] };
    }
  },
  removeProxy: {
    error: 'missing',
    apply: (state, msg) => {
      if (!state.proxies.some((p) => p.id === msg.id)) return null;
      const checkResults = { ...state.checkResults };
      delete checkResults[msg.id];
      const updates = {
        proxies: state.proxies.filter((p) => p.id !== msg.id),
        checkResults
      };
      if (state.activeId === msg.id) {
        updates.activeId = null;
        updates.enabled = false;
      }
      return updates;
    }
  },
  addRoutingRule: {
    error: 'duplicate',
    apply: (state, msg) => {
      const rule = normalizeRoutingRules([msg.rule])[0];
      if (!rule || state.routingRules.some((existing) => existing.pattern === rule.pattern)) return null;
      return { routingRules: [...state.routingRules, rule] };
    }
  },
  saveRoutingRule: {
    error: 'duplicate',
    apply: (state, msg) => {
      const index = state.routingRules.findIndex((rule) => rule.id === msg.id);
      if (index === -1) return null;
      const rule = normalizeRoutingRules([{ ...msg.rule, id: msg.id }])[0];
      if (
        !rule ||
        state.routingRules.some(
          (existing, existingIndex) => existingIndex !== index && existing.pattern === rule.pattern
        )
      ) {
        return null;
      }
      const routingRules = [...state.routingRules];
      routingRules[index] = rule;
      return { routingRules };
    }
  },
  setRoutingRuleAction: {
    error: 'missing',
    apply: (state, msg) => {
      const routingRules = [...state.routingRules];
      const index = routingRules.findIndex((rule) => rule.id === msg.id);
      if (index === -1 || !ROUTING_ACTIONS.includes(msg.action)) return null;
      routingRules[index] = { ...routingRules[index], action: msg.action };
      return { routingRules };
    }
  },
  moveRoutingRule: {
    error: 'missing',
    apply: (state, msg) => {
      const routingRules = [...state.routingRules];
      const from = routingRules.findIndex((rule) => rule.id === msg.id);
      const to = from + (msg.dir === -1 ? -1 : 1);
      if (from === -1 || to < 0 || to >= routingRules.length) return null;
      [routingRules[from], routingRules[to]] = [routingRules[to], routingRules[from]];
      return { routingRules };
    }
  },
  removeRoutingRule: {
    error: 'missing',
    apply: (state, msg) => {
      const routingRules = state.routingRules.filter((rule) => rule.id !== msg.id);
      return routingRules.length === state.routingRules.length ? null : { routingRules };
    }
  },
  setRoutingDefault: {
    apply: (_state, msg) => ({ routingDefault: normalizeRoutingDefault(msg.value) })
  }
};

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const respond = (promise) =>
    promise.then(
      (value) => sendResponse(value),
      () => sendResponse({ ok: false })
    );
  const mutationResponse = (promise, error = 'conflict') =>
    respond(promise.then((updates) => (updates ? { ok: true } : { ok: false, error })));

  if (!msg || typeof msg.type !== 'string') return;

  const mutation = MUTATIONS[msg.type];
  if (mutation) {
    if (mutation.accepts && !mutation.accepts(msg)) {
      sendResponse({ ok: false, error: 'invalid' });
      return;
    }
    mutationResponse(mutateState((state) => mutation.apply(state, msg)), mutation.error);
    return true;
  }

  if (msg.type === 'toggle') {
    respond(setEnabled(msg.on).then((ok) => ({ ok })));
    return true;
  }
  if (msg.type === 'saveProxy') {
    if (!hasValidProxyEndpoint(msg.proxy)) {
      sendResponse({ ok: false, error: 'invalid' });
      return;
    }
    let error = 'missing';
    respond(
      mutateState((state) => {
        const { proxies } = state;
        const index = proxies.findIndex((p) => p.id === msg.proxy.id);
        const next = makeProxy(msg.proxy);
        if (
          proxies.some(
            (p, currentIndex) => currentIndex !== index && proxyKey(p) === proxyKey(next)
          )
        ) {
          error = 'duplicate';
          return null;
        }
        if (index === -1) {
          if (msg.isEdit) return null;
          return { proxies: [...proxies, { ...next, revision: 0 }] };
        }
        const current = proxies[index];
        const expected = proxyRevision({ revision: msg.expectedRevision });
        if (msg.isEdit && proxyRevision(current) !== expected) {
          error = 'conflict';
          return null;
        }
        proxies[index] = { ...next, revision: proxyRevision(current) + 1 };
        const checkResults = { ...state.checkResults };
        delete checkResults[msg.proxy.id];
        return { proxies, checkResults };
      }).then((updates) => (updates ? { ok: true } : { ok: false, error }))
    );
    return true;
  }
  if (msg.type === 'check') {
    respond(enqueueCheck(msg.id));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts (unbound by default; users set keys in the browser).
// ---------------------------------------------------------------------------

if (api.commands) {
  api.commands.onCommand.addListener((command) => {
    if (command === 'toggle-proxy') {
      mutateState((state) => enabledUpdates(state, !state.enabled)).catch(() => {});
      return;
    }
    if (command === 'next-proxy' || command === 'prev-proxy') {
      mutateState(({ proxies, activeId }) => {
        if (proxies.length === 0) return null;
        const idx = proxies.findIndex((p) => p.id === activeId);
        const dir = command === 'next-proxy' ? 1 : -1;
        // With nothing active, next starts at the first proxy, prev at the last.
        const base = idx === -1 ? (dir === 1 ? -1 : proxies.length) : idx;
        const next = proxies[(base + dir + proxies.length) % proxies.length];
        return { activeId: next.id, enabled: true };
      }).catch(() => {});
    }
  });
}

async function init() {
  // The badge color is independent of the state scrub, so both start at once.
  await Promise.all([
    action.setBadgeBackgroundColor({ color: '#16a34a' }),
    scrubCheckResults().then(scheduleApply)
  ]);
}

// Top level so it runs on every Chrome service worker start, not only on
// onInstalled/onStartup. A worker death mid check leaves the temporary check
// settings applied; this re-applies saved state on the next wake.
init().catch(() => {});
