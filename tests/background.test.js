import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function extensionEvent() {
  return { addListener() {} };
}

async function loadChromeBackground(initial) {
  const stored = structuredClone(initial);
  const writes = [];
  const local = {
    async get(defaults) {
      return structuredClone({ ...defaults, ...stored });
    },
    async set(updates) {
      writes.push(structuredClone(updates));
      Object.assign(stored, structuredClone(updates));
    },
    async remove(keys) {
      for (const key of keys) delete stored[key];
    }
  };
  const resolved = async () => {};
  const chrome = {
    action: { setBadgeText: resolved, setIcon: resolved, setTitle: resolved },
    storage: {
      local,
      session: { async get(defaults) { return defaults; }, set: resolved },
      onChanged: extensionEvent()
    },
    proxy: {
      settings: {
        async get() { return { levelOfControl: 'controllable_by_this_extension' }; },
        set: resolved,
        clear: resolved
      }
    },
    declarativeNetRequest: {
      async getDynamicRules() { return []; },
      updateDynamicRules: resolved
    },
    webRequest: { onAuthRequired: extensionEvent() },
    runtime: { onMessage: extensionEvent(), async sendMessage() { return null; } },
    offscreen: { async hasDocument() { return true; }, createDocument: resolved },
    commands: { onCommand: extensionEvent() }
  };
  const context = vm.createContext({ URL, TextEncoder, Uint8Array, crypto: webcrypto, chrome });
  for (const file of ['shared.js', 'routing.js', 'platform-chrome.js', 'background.js']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  await vm.runInContext('writeQueue', context);
  await vm.runInContext('applyQueue', context);
  return { context, stored, writes };
}

test('legacy inline check results migrate without rewriting proxy records afterward', async () => {
  const proxy = {
    id: 'proxy-1',
    label: 'Local',
    scheme: 'http',
    host: '127.0.0.1',
    port: 8080,
    username: '',
    password: '',
    revision: 2,
    lastCheck: { ok: true, ip: '203.0.113.1', ms: 25, at: 10 }
  };
  const { context, stored, writes } = await loadChromeBackground({
    proxies: [proxy],
    activeId: proxy.id,
    enabled: false,
    routingDefault: 'proxy',
    routingRules: []
  });

  const state = await vm.runInContext('getState()', context);
  assert.equal('lastCheck' in state.proxies[0], false);
  assert.deepEqual(stored.checkResults[proxy.id], proxy.lastCheck);
  assert.equal(stored.proxies[0].revision, 2);

  writes.length = 0;
  await vm.runInContext(
    `saveCheckResult('proxy-1', { ok: false, error: 'Timed out', at: 20 }, 2)`,
    context
  );
  assert.deepEqual(Object.keys(writes.at(-1)), ['checkResults']);
  assert.equal(stored.proxies[0].revision, 2);
});

test('proxy checks measure reachability and latency', async () => {
  const proxy = {
    id: 'proxy-1',
    label: 'Local',
    scheme: 'http',
    host: '127.0.0.1',
    port: 8080,
    username: '',
    password: '',
    revision: 0
  };
  const { context } = await loadChromeBackground({ proxies: [proxy], routingRules: [] });
  let requestedUrl;
  vm.runInContext(
    `platformAdapter.controllable = async () => true;
     platformAdapter.checkFetch = async (url) => {
       globalThis.requestedUrl = url;
       return { ok: true, body: 'ignored', ms: 42 };
     }`,
    context
  );
  const result = await vm.runInContext(`enqueueCheck('proxy-1')`, context);
  assert.equal(result.ok, true);
  assert.equal(result.ms, 42);
  assert.equal(await vm.runInContext('requestedUrl', context), 'https://example.com/');
});

test('duplicate proxies and routing patterns are rejected', async () => {
  const { context } = await loadChromeBackground({ routingRules: [] });
  const duplicateProxy = vm.runInContext(
    `(() => {
      const proxy = makeProxy({ scheme: 'http', host: 'proxy.example', port: 8080 });
      return MUTATIONS.importProxies.apply(
        { proxies: [proxy] },
        { proxies: [makeProxy({ scheme: 'HTTP', host: 'PROXY.EXAMPLE', port: 8080 })] }
      );
    })()`,
    context
  );
  assert.equal(duplicateProxy, null);

  const duplicateRule = vm.runInContext(
    `MUTATIONS.addRoutingRule.apply(
      { routingRules: [{ id: 'rule-1', pattern: 'example.com', action: 'direct' }] },
      { rule: { pattern: 'EXAMPLE.COM', action: 'proxy' } }
    )`,
    context
  );
  assert.equal(duplicateRule, null);
});

test('routing rule edits preserve order and reject duplicate patterns', async () => {
  const { context } = await loadChromeBackground({ routingRules: [] });
  const edited = vm.runInContext(
    `MUTATIONS.saveRoutingRule.apply(
      {
        routingRules: [
          { id: 'rule-1', pattern: 'first.example', action: 'direct' },
          { id: 'rule-2', pattern: 'second.example', action: 'proxy' }
        ]
      },
      { id: 'rule-1', rule: { pattern: 'renamed.example', action: 'block' } }
    )`,
    context
  );
  assert.deepEqual(JSON.parse(JSON.stringify(edited.routingRules)), [
    { id: 'rule-1', pattern: 'renamed.example', action: 'block' },
    { id: 'rule-2', pattern: 'second.example', action: 'proxy' }
  ]);

  const duplicate = vm.runInContext(
    `MUTATIONS.saveRoutingRule.apply(
      {
        routingRules: [
          { id: 'rule-1', pattern: 'first.example', action: 'direct' },
          { id: 'rule-2', pattern: 'second.example', action: 'proxy' }
        ]
      },
      { id: 'rule-1', rule: { pattern: 'SECOND.EXAMPLE', action: 'block' } }
    )`,
    context
  );
  assert.equal(duplicate, null);
});

