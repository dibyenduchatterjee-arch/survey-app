// A thin layer over authFetch: JSON in, JSON out, and a thrown ApiError carrying the
// server's own words. Every console page takes an `api` made here, so tests hand in a
// stubbed fetch and never need a server.
export class ApiError extends Error {
  constructor(status, detail, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// Turns FastAPI's several `detail` shapes into readable lines.
export function detailLines(detail) {
  if (detail == null) return [];
  if (typeof detail === 'string') return [detail];
  if (Array.isArray(detail)) { // pydantic validation errors
    return detail.map(d => (d && d.msg ? `${(d.loc || []).slice(1).join('.')}${d.loc ? ': ' : ''}${d.msg}` : String(d)));
  }
  if (typeof detail === 'object') {
    const out = [];
    if (typeof detail.message === 'string') out.push(detail.message);
    if (Array.isArray(detail.messages)) out.push(...detail.messages.map(String));
    return out;
  }
  return [String(detail)];
}

export function createApi(authFetch) {
  async function request(path, { method = 'GET', json, form, query } = {}) {
    let url = path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== '' && v != null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const init = { method, headers: {} };
    if (json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
    if (form) init.body = form; // the browser sets the multipart boundary itself
    let res;
    try {
      res = await authFetch(url, init);
    } catch (e) {
      throw new ApiError(0, null, 'Could not reach the server. Check the connection and try again.');
    }
    if (res.status === 204) return null;
    let body = null;
    try { body = await res.clone().json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const detail = body && 'detail' in body ? body.detail : null;
      const lines = detailLines(detail);
      let msg = lines.join(' ') || `The server answered ${res.status}`;
      if (res.status === 401) msg = 'You are signed out. Sign in again.';
      if (res.status === 403) msg = 'Your role is not allowed to do this.';
      throw new ApiError(res.status, detail, msg);
    }
    return body;
  }
  return {
    request,
    get: (p, query) => request(p, { query }),
    post: (p, json) => request(p, { method: 'POST', json }),
    patch: (p, json) => request(p, { method: 'PATCH', json }),
    del: p => request(p, { method: 'DELETE' }),
    upload: (p, form) => request(p, { method: 'POST', form }),
    // For binary content (photos). Returns the Response untouched, or throws ApiError.
    async blob(p) {
      let res;
      try { res = await authFetch(p, { method: 'GET' }); } catch { throw new ApiError(0, null, 'Could not reach the server.'); }
      if (!res.ok) throw new ApiError(res.status, null, `The server answered ${res.status}`);
      return res.blob();
    },
  };
}
