import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadScripts(...files) {
  const context = vm.createContext({ URL, chrome: {} });
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context;
}

function globMatch(value, pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(value);
}

const cases = [
  { pattern: 'example.com', matches: ['https://example.com/'], misses: ['https://www.example.com/'] },
  { pattern: '.example.com', matches: ['https://example.com/', 'https://a.example.com/'], misses: ['https://notexample.com/'] },
  { pattern: '*.example.com', matches: ['https://a.example.com/', 'https://a.b.example.com/'], misses: ['https://example.com/'] },
  { pattern: '<local>', matches: ['http://printer/', 'http://[::1]/'], misses: ['http://printer.local/'] },
  { pattern: 'https://example.com/private/*', matches: ['https://example.com/private/a'], misses: ['https://example.com/public/a', 'http://example.com/private/a'] }
];

test('canonical matcher classifies every supported routing pattern', async () => {
  const context = await loadScripts('routing.js');
  const compile = vm.runInContext('compileRoutingRules', context);
  const decide = vm.runInContext('routingAction', context);

  for (const item of cases) {
    const rules = compile([{ pattern: item.pattern, action: 'block' }]);
    for (const url of item.matches) assert.equal(decide(new URL(url), rules, 'direct'), 'block', `${item.pattern}: ${url}`);
    for (const url of item.misses) assert.equal(decide(new URL(url), rules, 'direct'), 'direct', `${item.pattern}: ${url}`);
  }
});

test('Chromium PAC follows the canonical matcher for direct and proxy rules', async () => {
  const context = await loadScripts('shared.js', 'routing.js', 'platform-chrome.js');
  const makePac = vm.runInContext('chromePacScript', context);
  const proxy = { scheme: 'http', host: '127.0.0.1', port: 8080 };

  for (const item of cases) {
    const source = makePac(proxy, [{ pattern: item.pattern, action: 'direct' }], 'proxy');
    const pac = vm.createContext({
      shExpMatch: globMatch,
      dnsDomainIs: (host, suffix) => host.endsWith(suffix)
    });
    vm.runInContext(source, pac);
    for (const value of item.matches) {
      const url = new URL(value);
      assert.equal(pac.FindProxyForURL(url.href, url.hostname), 'DIRECT', `${item.pattern}: ${value}`);
    }
    for (const value of item.misses) {
      const url = new URL(value);
      assert.equal(pac.FindProxyForURL(url.href, url.hostname), 'PROXY 127.0.0.1:8080', `${item.pattern}: ${value}`);
    }
  }
});

test('Chromium DNR regexes follow the canonical matcher', async () => {
  const context = await loadScripts('shared.js', 'routing.js', 'platform-chrome.js');
  const makeRules = vm.runInContext('chromeRoutingRules', context);

  for (const item of cases) {
    const [rule] = makeRules([{ pattern: item.pattern, action: 'block' }]);
    const regex = new RegExp(rule.condition.regexFilter);
    assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
    for (const url of item.matches) assert.equal(regex.test(url), true, `${item.pattern}: ${url}`);
    for (const url of item.misses) assert.equal(regex.test(url), false, `${item.pattern}: ${url}`);
  }
});

test('first matching routing rule wins across canonical, PAC, and DNR output', async () => {
  const context = await loadScripts('shared.js', 'routing.js', 'platform-chrome.js');
  const rules = [
    { pattern: '.example.com', action: 'direct' },
    { pattern: 'secret.example.com', action: 'block' }
  ];
  const compiled = vm.runInContext('compileRoutingRules', context)(rules);
  const decide = vm.runInContext('routingAction', context);
  assert.equal(decide(new URL('https://secret.example.com/'), compiled, 'proxy'), 'direct');

  const dnr = vm.runInContext('chromeRoutingRules', context)(rules);
  assert.ok(dnr[0].priority > dnr[1].priority);
  assert.equal(dnr[0].action.type, 'allow');
});
