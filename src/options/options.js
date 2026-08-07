const form = document.getElementById('add-form');
const proxyInput = document.getElementById('proxy-input');
const schemeEl = document.getElementById('scheme');
const editNameRow = document.getElementById('edit-name-row');
const labelEl = document.getElementById('label');
const submitBtn = document.getElementById('submit-btn');
const cancelBtn = document.getElementById('cancel-edit');
const socksWarn = document.getElementById('socks-warn');
const addStatus = document.getElementById('add-status');
const listEl = document.getElementById('proxy-list');
const routingForm = document.getElementById('routing-form');
const routingDefaultEl = document.getElementById('routing-default');
const routingPattern = document.getElementById('routing-pattern');
const routingAction = document.getElementById('routing-action');
const routingList = document.getElementById('routing-list');
const routingEmpty = document.getElementById('routing-empty');
const routingStatus = document.getElementById('routing-status');
const routingSubmitBtn = document.getElementById('routing-submit');
const routingCancelBtn = document.getElementById('routing-cancel');

let editingId = null;
let editingRevision = null;
let routingRenderVersion = 0;
let routingEditingId = null;
let proxyRenderVersion = 0;

// All state writes go through the background (shared.js sendMessage) so
// read-modify-write cycles from different pages can not clobber each other.

// ---------------------------------------------------------------------------
// Parsing and record construction. Providers usually export
// "host:port:user:pass" or "user:pass@host:port", optional scheme:// prefix.
// ---------------------------------------------------------------------------

function parseProxyString(raw) {
  let text = raw.trim();
  let scheme = null;
  const prefix = text.match(/^(https?|socks5?):\/\//i);
  if (prefix) {
    scheme = prefix[1].toLowerCase();
    if (scheme === 'socks') scheme = 'socks5';
    text = text.slice(prefix[0].length);
  }
  if (!text.includes(':')) return null;

  if (text.includes('@')) {
    const at = text.lastIndexOf('@');
    const auth = text.slice(0, at);
    const colon = auth.indexOf(':');
    const addr = splitAddr(text.slice(at + 1));
    if (!addr) return null;
    const username = colon === -1 ? auth : auth.slice(0, colon);
    const password = colon === -1 ? '' : auth.slice(colon + 1);
    if (!username) return null;
    return { host: addr.host, port: addr.port, username, password, scheme };
  }

  // host:port[:user[:pass]] where an IPv6 host must be bracketed: [::1]:1080
  let host;
  let rest;
  const bracket = text.match(/^\[([^\]]+)\]:(.+)$/);
  if (bracket) {
    host = bracket[1];
    rest = bracket[2];
  } else {
    const colon = text.indexOf(':');
    host = text.slice(0, colon);
    rest = text.slice(colon + 1);
  }
  const parts = rest.split(':');
  if (!host || !/^\d+$/.test(parts[0] || '')) return null;
  const port = parts[0];
  const username = parts[1] || '';
  const password = parts.length > 2 ? parts.slice(2).join(':') : '';
  if (password && !username) return null;
  return { host, port, username, password, scheme };
}

// host:port where the host may be a bracketed IPv6 literal. The brackets are
// stripped for storage; consumers add them back where URLs need them.
function splitAddr(addr) {
  const bracket = addr.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) return { host: bracket[1], port: bracket[2] };
  const parts = addr.split(':');
  if (parts.length !== 2 || !parts[0] || !/^\d+$/.test(parts[1])) return null;
  return { host: parts[0], port: parts[1] };
}

function nonEmptyLines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

// proxyHostPort brackets a bare IPv6 literal, so the string it produces
// round-trips back through parseProxyString.
function proxyToString(proxy) {
  const hostPort = proxyHostPort(proxy);
  return proxy.username
    ? `${proxy.username}${proxy.password ? ':' + proxy.password : ''}@${hostPort}`
    : hostPort;
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------
function resizeProxyInput() {
  proxyInput.style.height = 'auto';
  proxyInput.style.height = `${proxyInput.scrollHeight}px`;
}

resizeProxyInput();


function clearAddStatus() {
  addStatus.textContent = '';
}

function updateSocksWarn() {
  const firstLine = nonEmptyLines(proxyInput.value)[0] || '';
  const parsed = parseProxyString(firstLine);
  socksWarn.hidden = IS_FIREFOX || !(schemeEl.value === 'socks5' && parsed && parsed.username);
}
schemeEl.addEventListener('change', () => {
  clearAddStatus();
  updateSocksWarn();
});
proxyInput.addEventListener('input', () => {
  resizeProxyInput();
  clearAddStatus();
  updateSocksWarn();
});

function exitEditMode() {
  editingId = null;
  editingRevision = null;
  form.reset();
  labelEl.value = '';
  resizeProxyInput();
  editNameRow.hidden = true;
  submitBtn.textContent = 'Add';
  cancelBtn.hidden = true;
  clearAddStatus();
  updateSocksWarn();
}

function startEdit(proxy) {
  editingId = proxy.id;
  editingRevision = proxyRevision(proxy);
  proxyInput.value = proxyToString(proxy);
  resizeProxyInput();
  schemeEl.value = proxy.scheme || 'http';
  labelEl.value = proxy.label || '';
  editNameRow.hidden = false;
  submitBtn.textContent = 'Save';
  cancelBtn.hidden = false;
  clearAddStatus();
  updateSocksWarn();
  proxyInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

cancelBtn.addEventListener('click', exitEditMode);

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (editingId) {
    const parsed = parseProxyString(proxyInput.value.trim());
    const proxy = parsed && makeProxy({ ...parsed, id: editingId, label: labelEl.value, scheme: parsed.scheme || schemeEl.value });
    if (!proxy || !hasValidProxyEndpoint(proxy)) return;
    // The fresh record intentionally drops the stale lastCheck.
    const result = await sendMessage({ type: 'saveProxy', proxy, isEdit: true, expectedRevision: editingRevision });
    if (result && result.ok) {
      exitEditMode();
    } else {
      addStatus.textContent =
        result && result.error === 'duplicate'
          ? 'A proxy with the same endpoint already exists.'
          : result && result.error === 'missing'
            ? 'Proxy was deleted in another tab.'
            : result && result.error === 'conflict'
              ? 'Proxy changed in another tab. Open it again.'
              : "Couldn't save proxy.";
    }
    return;
  }

  const lines = nonEmptyLines(proxyInput.value);
  const added = [];
  let skipped = 0;
  for (const line of lines) {
    const parsed = parseProxyString(line);
    const proxy = parsed && makeProxy({ ...parsed, scheme: parsed.scheme || schemeEl.value });
    if (proxy && hasValidProxyEndpoint(proxy)) added.push(proxy);
    else skipped++;
  }
  if (!added.length) {
    addStatus.textContent = 'No valid proxies. Check the format.';
    proxyInput.focus();
    return;
  }

  const result = await sendMessage({ type: 'importProxies', proxies: added });
  if (!(result && result.ok)) {
    addStatus.textContent =
      result && result.error === 'duplicate'
        ? 'A proxy with the same endpoint already exists.'
        : "Couldn't add proxies.";
    proxyInput.focus();
    return;
  }

  addStatus.textContent = skipped ? `Added ${added.length}, skipped ${skipped}` : '';
  form.reset();
  resizeProxyInput();
  updateSocksWarn();
  proxyInput.focus();
});

// ---------------------------------------------------------------------------
// Ordered routing rules
// ---------------------------------------------------------------------------

// Read-only projection for rendering. Unlike normalizeRoutingRules this keeps
// whatever id the stored rule has and never mints one: a client-side id would
// address a rule the background does not know about. Rules the background has
// not yet healed therefore render with their controls disabled.
function routingRulesFrom(state) {
  if (!Array.isArray(state.routingRules)) return [];
  const rules = [];
  for (const rule of state.routingRules) {
    const pattern = normalizeRoutingPattern(rule && rule.pattern);
    if (pattern && ROUTING_ACTIONS.includes(rule.action)) rules.push({ ...rule, pattern });
  }
  return rules;
}

async function renderRoutingRules() {
  const version = ++routingRenderVersion;
  const state = await api.storage.local.get(DEFAULT_STATE);
  if (version !== routingRenderVersion) return;
  const routingRules = routingRulesFrom(state);
  routingDefaultEl.value = normalizeRoutingDefault(state.routingDefault);
  routingEmpty.hidden = routingRules.length > 0;

  const frag = document.createDocumentFragment();
  routingRules.forEach((rule, index) => {
    const row = document.createElement('div');
    row.className = 'routing-rule';

    const pattern = document.createElement('span');
    pattern.className = 'routing-pattern truncate';
    pattern.textContent = rule.pattern;
    pattern.title = rule.pattern;

    const action = document.createElement('select');
    action.setAttribute('aria-label', `Action for ${rule.pattern}`);
    for (const value of ROUTING_ACTIONS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value[0].toUpperCase() + value.slice(1);
      option.selected = value === rule.action;
      action.appendChild(option);
    }
    action.addEventListener('change', () => {
      sendRoutingMutation({ type: 'setRoutingRuleAction', id: rule.id, action: action.value });
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.disabled = !rule.id;
    edit.addEventListener('click', () => startRoutingEdit(rule));

    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '↑';
    up.title = 'Move rule up';
    up.disabled = index === 0 || !rule.id;
    up.addEventListener('click', () => {
      sendRoutingMutation({ type: 'moveRoutingRule', id: rule.id, dir: -1 });
    });

    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '↓';
    down.title = 'Move rule down';
    down.disabled = index === routingRules.length - 1 || !rule.id;
    down.addEventListener('click', () => {
      sendRoutingMutation({ type: 'moveRoutingRule', id: rule.id, dir: 1 });
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.disabled = !rule.id;
    remove.addEventListener('click', () => {
      sendRoutingMutation({ type: 'removeRoutingRule', id: rule.id });
    });

    row.append(pattern, action, edit, up, down, remove);
    frag.appendChild(row);
  });
  routingList.replaceChildren(frag);
}

function sendRoutingMutation(msg) {
  return sendMessage(msg).then((result) => {
    if (!(result && result.ok)) renderRoutingRules();
    return result;
  });
}

function exitRoutingEditMode() {
  routingEditingId = null;
  routingForm.reset();
  routingSubmitBtn.textContent = 'Add';
  routingCancelBtn.hidden = true;
  routingStatus.textContent = '';
}

function startRoutingEdit(rule) {
  routingEditingId = rule.id;
  routingPattern.value = rule.pattern;
  routingAction.value = rule.action;
  routingSubmitBtn.textContent = 'Save';
  routingCancelBtn.hidden = false;
  routingStatus.textContent = '';
  routingPattern.focus();
}

routingCancelBtn.addEventListener('click', exitRoutingEditMode);

routingPattern.addEventListener('input', () => {
  routingStatus.textContent = '';
});

routingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pattern = normalizeRoutingPattern(routingPattern.value);
  if (!pattern || !ROUTING_ACTIONS.includes(routingAction.value)) {
    routingStatus.textContent = 'Enter a valid hostname or URL pattern.';
    routingPattern.focus();
    return;
  }
  const result = await sendMessage(
    routingEditingId
      ? { type: 'saveRoutingRule', id: routingEditingId, rule: { pattern, action: routingAction.value } }
      : { type: 'addRoutingRule', rule: { pattern, action: routingAction.value } }
  );
  if (!(result && result.ok)) {
    routingStatus.textContent =
      result && result.error === 'duplicate'
        ? 'This routing pattern already exists.'
        : routingEditingId
          ? "Couldn't save routing rule."
          : "Couldn't add routing rule.";
    routingPattern.focus();
    return;
  }
  if (routingEditingId) {
    exitRoutingEditMode();
  } else {
    routingStatus.textContent = '';
    routingPattern.value = '';
    routingPattern.focus();
  }
});

routingDefaultEl.addEventListener('change', () => {
  sendRoutingMutation({ type: 'setRoutingDefault', value: routingDefaultEl.value });
});

// ---------------------------------------------------------------------------
// Proxy list
// ---------------------------------------------------------------------------

async function removeProxy(id) {
  const result = await sendMessage({ type: 'removeProxy', id });
  if (result && result.ok && editingId === id) exitEditMode();
}

function formatCheck(lc) {
  if (!lc) return { text: '', cls: '' };
  if (lc.pending) return { text: 'Checking…', cls: 'pending' };
  if (!lc.ok) return { text: lc.error || 'Failed', cls: 'err' };
  const parts = [];
  parts.push(`${lc.ms} ms`);
  return { text: parts.join(' · '), cls: 'ok' };
}

async function render() {
  const version = ++proxyRenderVersion;
  const state = await api.storage.local.get(DEFAULT_STATE);
  if (version !== proxyRenderVersion) return;
  const { activeId } = state;
  const proxies = attachCheckResults(state.proxies, state.checkResults);
  listEl.hidden = proxies.length === 0;

  const frag = document.createDocumentFragment();
  for (const proxy of proxies) {
    const row = document.createElement('div');
    row.className =
      'proxy-row' + (proxy.id === activeId ? ' active' : '') + checkStateClass(proxy);

    const dot = document.createElement('span');
    dot.className = 'proxy-dot status-dot';

    const info = document.createElement('div');
    info.className = 'proxy-info';

    const name = document.createElement('div');
    name.className = 'proxy-name';
    name.textContent = displayName(proxy);

    const addr = document.createElement('div');
    addr.className = 'proxy-addr';
    const scheme = proxy.scheme || 'http';
    addr.textContent = (scheme !== 'http' ? `${scheme}://` : '') + proxyHostPort(proxy);

    info.append(name, addr);

    if (proxy.username) {
      const auth = document.createElement('div');
      auth.className = 'proxy-auth truncate';
      auth.textContent = `username: ${proxy.username}`;
      auth.title = proxy.username;
      info.appendChild(auth);
    }

    const { text, cls } = formatCheck(proxy.lastCheck);
    let result;
    if (text) {
      result = document.createElement('div');
      result.className = `check-result truncate ${cls}`;
      result.textContent = text;
      result.title = text;
      if (proxy.lastCheck.at && !proxy.lastCheck.pending) {
        result.title += `\nChecked ${new Date(proxy.lastCheck.at).toLocaleString()}`;
      }
    }

    const checkBtn = document.createElement('button');
    checkBtn.textContent = 'Check';
    checkBtn.title = 'Check proxy';
    checkBtn.addEventListener('click', () => {
      sendMessage({ type: 'check', id: proxy.id });
    });


    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEdit(proxy));

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => removeProxy(proxy.id));

    row.append(dot, info);
    if (result) row.appendChild(result);
    row.append(checkBtn, editBtn, delBtn);
    frag.appendChild(row);
  }
  listEl.replaceChildren(frag);
}


// Re-render whenever proxy data, check results, or routing rules change.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.proxies || changes.checkResults) render();
  if (changes.routingRules || changes.routingDefault) renderRoutingRules();
});

// ---------------------------------------------------------------------------
// Keyboard shortcut settings
// ---------------------------------------------------------------------------

const shortcutLink = document.getElementById('shortcut-link');
const shortcutUrl = IS_FIREFOX ? 'about:addons' : 'chrome://extensions/shortcuts';
shortcutLink.title = IS_FIREFOX
  ? 'Open Add-ons Manager to set shortcuts'
  : 'Open shortcut settings';
shortcutLink.addEventListener('click', (event) => {
  event.preventDefault();
  api.tabs.create({ url: shortcutUrl });
});

renderRoutingRules();
render();
