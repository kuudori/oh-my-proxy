// Timed connectivity fetch, shared by the Firefox background page and the
// Chrome offscreen check worker. Returns {ok:true, ms, body} or
// {ok:false, error} where error is 'timeout', 'network' or 'HTTP <status>'.

async function timedCheckFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const res = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error'
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, ms, body: await res.text() };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
