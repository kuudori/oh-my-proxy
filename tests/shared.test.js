import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadShared() {
  const context = vm.createContext({ URL, chrome: {} });
  vm.runInContext(await readFile(new URL('../shared.js', import.meta.url), 'utf8'), context);
  return context;
}

test('proxy host validation accepts endpoints and rejects URL delimiters', async () => {
  const { canonicalProxyHost, isValidProxyHost } = await loadShared();

  assert.equal(canonicalProxyHost('99'), '0.0.0.99');
  assert.equal(isValidProxyHost('proxy.example'), true);
  assert.equal(isValidProxyHost('::1'), true);
  for (const host of ['[]', '?', 'example.com/path', 'example.com#fragment']) {
    assert.equal(isValidProxyHost(host), false, host);
  }
});

test('routing patterns are canonical and reject ambiguous forms', async () => {
  const { normalizeRoutingPattern } = await loadShared();

  assert.equal(normalizeRoutingPattern('HTTPS://EXAMPLE.COM/path*'), 'https://example.com/path*');
  assert.equal(normalizeRoutingPattern('::1'), '[::1]');
  assert.equal(normalizeRoutingPattern('https://[::1]/*'), 'https://[::1]/*');
  for (const pattern of ['https://', '://', 'foo*bar', 'example.com:443']) {
    assert.equal(normalizeRoutingPattern(pattern), null, pattern);
  }
});

test('check results attach only from own keyed entries', async () => {
  const { attachCheckResults } = await loadShared();
  const proxies = [{ id: 'toString' }, { id: 'proxy-1' }];
  const hydrated = attachCheckResults(proxies, { 'proxy-1': { ok: true, ms: 5 } });

  assert.equal(hydrated[0].lastCheck, undefined);
  assert.equal(hydrated[1].lastCheck.ms, 5);
});
