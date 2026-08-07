// Canonical routing compiler shared by both browser adapters.
//
// Patterns are normalized in shared.js. This file classifies each normalized
// pattern once; Firefox evaluates the descriptors directly, while Chromium
// compiles the same descriptors to PAC data and DNR regular expressions.

function compileRoutingPattern(pattern) {
  if (pattern.includes('://')) return { kind: 'url', value: pattern };
  if (pattern === '<local>') return { kind: 'local', value: '' };
  if (pattern.startsWith('*.')) return { kind: 'subdomains', value: pattern.slice(2) };
  if (pattern.startsWith('.')) return { kind: 'domain', value: pattern.slice(1) };
  return { kind: 'host', value: pattern };
}

function compileRoutingRules(rules) {
  return rules.map((rule) => ({ ...compileRoutingPattern(rule.pattern), action: rule.action }));
}

function matchesRoutingGlob(value, pattern) {
  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starMatch = 0;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      valueIndex++;
      patternIndex++;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex++;
      starMatch = valueIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      valueIndex = ++starMatch;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

function matchesCompiledRoutingPattern(url, host, pattern) {
  if (pattern.kind === 'url') return matchesRoutingGlob(url.href, pattern.value);
  if (pattern.kind === 'local') return !host.includes('.');
  if (pattern.kind === 'subdomains') {
    return host.length > pattern.value.length && host.endsWith(`.${pattern.value}`);
  }
  if (pattern.kind === 'domain') {
    return host === pattern.value || host.endsWith(`.${pattern.value}`);
  }
  return host === pattern.value;
}

function routingAction(url, compiledRules, defaultRoute) {
  const host = url.hostname.toLowerCase();
  for (const rule of compiledRules) {
    if (matchesCompiledRoutingPattern(url, host, rule)) return rule.action;
  }
  return defaultRoute;
}

function escapeRoutingRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compiledPatternRegex(pattern) {
  if (pattern.kind === 'url') {
    return `^${pattern.value.split('*').map(escapeRoutingRegex).join('.*')}$`;
  }

  const authorityPrefix = '^[a-z][a-z0-9+.-]*://(?:[^/@]*@)?';
  const authoritySuffix = '(?::[0-9]+)?(?:/|$)';
  if (pattern.kind === 'local') {
    return `${authorityPrefix}(?:\\[[0-9a-f:]+\\]|[^./:@]+)${authoritySuffix}`;
  }
  if (pattern.kind === 'subdomains') {
    return `${authorityPrefix}(?:[^./:@]+\\.)+${escapeRoutingRegex(pattern.value)}${authoritySuffix}`;
  }
  if (pattern.kind === 'domain') {
    return `${authorityPrefix}(?:[^./:@]+\\.)*${escapeRoutingRegex(pattern.value)}${authoritySuffix}`;
  }
  return `${authorityPrefix}${escapeRoutingRegex(pattern.value)}${authoritySuffix}`;
}
