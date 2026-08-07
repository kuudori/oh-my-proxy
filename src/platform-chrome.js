// Chromium MV3 adapter: PAC proxy routing, DNR blocking, callback auth, and
// offscreen connectivity checks.

function chromeProxyDirective(proxy) {
  const hostPort = proxyHostPort(proxy);
  if ((proxy.scheme || 'http') === 'socks5') return `SOCKS5 ${hostPort}`;
  return `${proxy.scheme === 'https' ? 'HTTPS' : 'PROXY'} ${hostPort}`;
}

function chromePacScript(proxy, routingRules, defaultRoute) {
  const rules = JSON.stringify(
    compileRoutingRules(routingRules).filter((rule) => rule.action !== 'block')
  );
  const directive = JSON.stringify(chromeProxyDirective(proxy));
  const fallback = defaultRoute === 'proxy' ? directive : "'DIRECT'";
  return `
var routingRules = ${rules};

function matchesRoutingPattern(url, host, rule) {
  if (rule.kind === 'url') return shExpMatch(url, rule.value);
  if (rule.kind === 'local') return host.indexOf('.') === -1;
  if (rule.kind === 'subdomains') {
    return host.length > rule.value.length && dnsDomainIs(host, '.' + rule.value);
  }
  if (rule.kind === 'domain') {
    return host === rule.value || dnsDomainIs(host, '.' + rule.value);
  }
  return host === rule.value;
}

function FindProxyForURL(url, host) {
  var lowerHost = host.toLowerCase();
  for (var i = 0; i < routingRules.length; i++) {
    var rule = routingRules[i];
    if (matchesRoutingPattern(url, lowerHost, rule)) {
      return rule.action === 'proxy' ? ${directive} : 'DIRECT';
    }
  }
  return ${fallback};
}`;
}

function chromeProxyConfig(proxy, routingRules, defaultRoute) {
  return {
    mode: 'pac_script',
    pacScript: { data: chromePacScript(proxy, routingRules, defaultRoute) }
  };
}

function chromeRoutingRules(routingRules) {
  const compiled = compileRoutingRules(routingRules);
  return compiled.map((rule, index) => ({
    id: index + 1,
    priority: compiled.length - index,
    action: { type: rule.action === 'block' ? 'block' : 'allow' },
    condition: { regexFilter: compiledPatternRegex(rule), isUrlFilterCaseSensitive: true }
  }));
}

async function replaceChromeRoutingRules(active, routingRules) {
  const existing = await api.declarativeNetRequest.getDynamicRules();
  await api.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: active ? chromeRoutingRules(routingRules) : []
  });
}

const platformAdapter = {
  async controllable() {
    const setting = await api.proxy.settings.get({});
    return (
      setting.levelOfControl === 'controlled_by_this_extension' ||
      setting.levelOfControl === 'controllable_by_this_extension'
    );
  },

  async applySavedConfig({ active, proxy, routingRules, routingDefault }) {
    await Promise.all([
      active
        ? api.proxy.settings.set({
            value: chromeProxyConfig(proxy, routingRules, routingDefault),
            scope: 'regular'
          })
        : api.proxy.settings.clear({ scope: 'regular' }),
      replaceChromeRoutingRules(active, routingRules)
    ]);
  },

  async applyCheckConfig({ checkingDirect, activeCheck }) {
    const value = checkingDirect
      ? { mode: 'direct' }
      : chromeProxyConfig(activeCheck, [], 'proxy');
    await Promise.all([
      api.proxy.settings.set({ value, scope: 'regular' }),
      replaceChromeRoutingRules(false, [])
    ]);
  },

  onStorageChanged() {},

  start({ authDecision }) {
    api.webRequest.onAuthRequired.addListener(
      (details, callback) => authDecision(details).then(callback),
      { urls: ['<all_urls>'] },
      ['asyncBlocking']
    );
  },

  async loadAnsweredAuth() {
    if (!api.storage.session) return {};
    const stored = await api.storage.session.get({ answeredAuth: {} });
    return stored.answeredAuth;
  },

  saveAnsweredAuth(answeredAuth) {
    if (api.storage.session) api.storage.session.set({ answeredAuth }).catch(() => {});
  },

  async checkFetch(url, timeoutMs) {
    if (!(await api.offscreen.hasDocument())) {
      await api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification:
          'Proxy auth is not delivered for service worker requests, so check requests run in a worker'
      });
    }
    const response = await api.runtime.sendMessage({ type: 'offscreen-check', url, timeoutMs });
    return response || { ok: false, error: 'network' };
  }
};
