const toggleEl = document.getElementById('toggle');
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');

let renderVersion = 0;

async function render() {
  const version = ++renderVersion;
  const state = await api.storage.local.get(DEFAULT_STATE);
  if (version !== renderVersion) return;
  const { activeId, enabled } = state;
  const proxies = attachCheckResults(state.proxies, state.checkResults);

  toggleEl.checked = enabled;
  emptyEl.hidden = proxies.length > 0;

  const frag = document.createDocumentFragment();
  for (const proxy of proxies) {
    const btn = document.createElement('button');
    btn.className =
      'item' + (proxy.id === activeId ? ' active' : '') + checkStateClass(proxy);

    const dot = document.createElement('span');
    dot.className = 'dot status-dot';

    const name = document.createElement('span');
    name.className = 'name truncate';
    name.textContent = displayName(proxy);

    btn.append(dot, name);

    if (proxy.lastCheck?.ok && Number.isFinite(proxy.lastCheck.ms)) {
      const latency = document.createElement('span');
      latency.className = 'latency';
      latency.textContent = `${proxy.lastCheck.ms} ms`;
      btn.appendChild(latency);
    }

    const addr = document.createElement('span');
    addr.className = 'addr truncate';
    addr.textContent = proxyHostPort(proxy);
    btn.appendChild(addr);

    btn.addEventListener('click', () => {
      sendMessage({ type: 'setActive', id: proxy.id });
    });
    frag.appendChild(btn);
  }
  listEl.replaceChildren(frag);
}

toggleEl.addEventListener('change', async () => {
  const on = toggleEl.checked;
  // sendMessage resolves null when the background is unreachable (reload or
  // update); that falls into the resync branch below.
  const res = await sendMessage({ type: 'toggle', on });
  if (!(res && res.ok)) {
    render();
    if (on) api.runtime.openOptionsPage();
  }
});

document.getElementById('settings').addEventListener('click', () => {
  api.runtime.openOptionsPage();
});

// The storage listener is the single render trigger; writes above rely on it.
api.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') render();
});

render();
