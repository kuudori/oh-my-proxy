// Chrome only. Hosts the worker that performs check requests. Checks are
// serialized by the background, so at most one request is in flight.

const worker = new Worker('check-worker.js');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'offscreen-check') return;
  const onResult = (e) => {
    worker.removeEventListener('message', onResult);
    sendResponse(e.data);
  };
  worker.addEventListener('message', onResult);
  worker.postMessage({ url: msg.url, timeoutMs: msg.timeoutMs });
  return true;
});
