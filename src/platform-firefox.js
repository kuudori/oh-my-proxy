// Firefox MV2 adapter: synchronous per-request routing and blocking, promise
// based auth, and direct background-page connectivity checks.

function firefoxProxyInfo(proxy) {
  if ((proxy.scheme || 'http') === 'socks5') {
    return {
      type: 'socks',
      host: proxy.host,
      port: Number(proxy.port),
      proxyDNS: true,
      username: proxy.username || undefined,
      password: proxy.password || undefined
    };
  }
  return {
    type: proxy.scheme === 'https' ? 'https' : 'http',
    host: proxy.host,
    port: Number(proxy.port)
  };
}

function firefoxActiveProxy(state) {
  const proxy = state.enabled ? state.proxies.find((item) => item.id === state.activeId) : null;
  return proxy && hasValidProxyEndpoint(proxy) ? proxy : null;
}

const platformAdapter = (() => {
  let state = null;
  let refreshPromise = null;
  let refreshQueued = false;
  let getState;
  let getCheckState;

  function refresh(force = false) {
    if (force) {
      state = null;
      refreshQueued = true;
    }
    if (refreshPromise) return refreshPromise;
    const pending = (async () => {
      do {
        refreshQueued = false;
        const next = await getState();
        if (refreshQueued) continue;
        state = { ...next, compiledRoutingRules: compileRoutingRules(next.routingRules) };
        return state;
      } while (true);
    })();
    refreshPromise = pending.finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function proxyDecision(current, details) {
    const proxy = firefoxActiveProxy(current);
    if (!proxy) return { type: 'direct' };
    const action = routingAction(
      new URL(details.url),
      current.compiledRoutingRules,
      current.routingDefault
    );
    return action === 'proxy' ? firefoxProxyInfo(proxy) : { type: 'direct' };
  }

  function blockDecision(current, details) {
    if (!firefoxActiveProxy(current)) return {};
    const action = routingAction(
      new URL(details.url),
      current.compiledRoutingRules,
      current.routingDefault
    );
    return action === 'block' ? { cancel: true } : {};
  }

  return {
    async controllable() {
      return true;
    },

    async applySavedConfig() {},
    async applyCheckConfig() {},

    onStorageChanged() {
      refresh(true);
    },

    start(context) {
      getState = context.getState;
      getCheckState = context.getCheckState;
      browser.proxy.onRequest.addListener(
        (details) => {
          const check = getCheckState();
          if (check.checkingDirect) return { type: 'direct' };
          if (check.activeCheck) return firefoxProxyInfo(check.activeCheck);
          if (state) return proxyDecision(state, details);
          return refresh().then((current) => proxyDecision(current, details));
        },
        { urls: ['<all_urls>'] }
      );
      browser.webRequest.onBeforeRequest.addListener(
        (details) => {
          const check = getCheckState();
          if (check.checkingDirect || check.activeCheck) return {};
          if (state) return blockDecision(state, details);
          return refresh().then((current) => blockDecision(current, details));
        },
        { urls: ['<all_urls>'] },
        ['blocking']
      );
      api.webRequest.onAuthRequired.addListener(
        context.authDecision,
        { urls: ['<all_urls>'] },
        ['blocking']
      );
    },

    async loadAnsweredAuth() {
      return {};
    },

    saveAnsweredAuth() {},

    checkFetch(url, timeoutMs) {
      return timedCheckFetch(url, timeoutMs);
    }
  };
})();
