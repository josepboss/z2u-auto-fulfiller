// injected.js — runs in PAGE context (not isolated extension world)
// Intercepts XHR and fetch to capture Z2U's upload API endpoint.
// Communicates back to the content script via window.postMessage.

(() => {
  'use strict';

  // Logs EVERY POST request so we can see what Z2U actually sends
  function logRequest(url, method, body) {
    const m = (method || 'GET').toUpperCase();
    if (m !== 'POST') return;

    let bodyType = 'none';
    let hasFile  = false;
    const fields = [];

    if (body instanceof FormData) {
      bodyType = 'FormData';
      for (const [key, val] of body.entries()) {
        if (val instanceof File || val instanceof Blob) {
          fields.push({ key, type: 'file', name: val instanceof File ? val.name : 'blob', size: val.size });
          hasFile = true;
        } else {
          fields.push({ key, type: 'string', value: String(val) });
        }
      }
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      bodyType = 'binary';
    } else if (typeof body === 'string') {
      bodyType = 'string';
    } else if (body) {
      bodyType = body.constructor?.name || typeof body;
    }

    console.log(`[Z2U-interceptor] POST ${url} | body=${bodyType} | fields=${JSON.stringify(fields)}`);

    // Only save if it's a FormData upload with a file attached
    if (bodyType === 'FormData' && hasFile) {
      console.log('[Z2U-interceptor] ✅ File upload detected — saving endpoint');
      window.postMessage({
        source: '__z2u_injected__',
        type:   'UPLOAD_REQUEST_CAPTURED',
        url:    String(url),
        method: m,
        fields,
      }, '*');
    }
  }

  // ── Intercept XMLHttpRequest ────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__z2u_method = method;
    this.__z2u_url    = String(url);
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try { logRequest(this.__z2u_url, this.__z2u_method || 'POST', body); } catch (_) {}
    return origSend.apply(this, arguments);
  };

  // ── Intercept fetch ─────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (input, init = {}) {
    try {
      const url    = input instanceof Request ? input.url : String(input);
      const method = (init.method || (input instanceof Request ? input.method : 'GET'));
      logRequest(url, method, init.body);
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  console.log('[Z2U] Network interceptor active in page context');
})();
