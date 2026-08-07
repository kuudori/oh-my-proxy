// Chrome only. Runs the check request from a worker because proxy auth
// challenges are not delivered for fetches made by extension contexts
// themselves (crbug.com/1371177), while worker requests do get them.

importScripts('check-fetch.js');

onmessage = async (e) => {
  postMessage(await timedCheckFetch(e.data.url, e.data.timeoutMs));
};
