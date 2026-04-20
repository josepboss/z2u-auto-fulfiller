// injected.js — runs in PAGE context (not isolated extension world)
// Intercepts XHR and fetch so we can capture Z2U's upload API endpoint.
// Communicates back to the content script via window.postMessage.

(() => {
  'use strict';

  function captureUploadRequest(url, method, body) {
    if (method.toUpperCase() !== 'POST') return;
    if (!(body instanceof FormData)) return;

    const fields = [];
    let hasFile = false;

    for (const [key, val] of body.entries()) {
      if (val instanceof File || val instanceof Blob) {
        fields.push({
          key,
          type: 'file',
          name: val instanceof File ? val.name : 'blob',
          size: val.size,
        });
        hasFile = true;
      } else {
        fields.push({ key, type: 'string', value: String(val) });
      }
    }

    if (!hasFile) return;

    console.log('[Z2U-interceptor] Upload request captured:', method, url, fields);

    window.postMessage({
      source: '__z2u_injected__',
      type:   'UPLOAD_REQUEST_CAPTURED',
      url:    String(url),
      method: method.toUpperCase(),
      fields,
    }, '*');
  }

  // ── Intercept XMLHttpRequest ──────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__z2u_method = method;
    this.__z2u_url    = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try { captureUploadRequest(this.__z2u_url, this.__z2u_method || 'POST', body); } catch (_) {}
    return origSend.apply(this, arguments);
  };

  // ── Intercept fetch ───────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    try {
      const url    = input instanceof Request ? input.url : String(input);
      const method = init.method || (input instanceof Request ? input.method : 'GET');
      captureUploadRequest(url, method, init.body);
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  console.log('[Z2U] Network interceptor active in page context');
})();
