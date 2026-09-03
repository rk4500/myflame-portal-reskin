// ---------------------------------------------------------------------
// 1. Aura context/token/userId capture
//
// Instead of parsing window.Aura.appBootstrap (fragile, format shifts
// between Aura versions), snoop the page's own outgoing aura requests.
// The page fires several of these on every load (nav menu, notif tray,
// etc — confirmed in aura_map.md), so we get a working context+token
// within the first second, and it self-refreshes if the page rotates
// the token later.
// ---------------------------------------------------------------------

export const auraState = {
  context: null,   // raw aura.context string (JSON), reused verbatim
  token: null,     // raw aura.token string
  userId: null,    // Salesforce User Id, sniffed from any params.userId
};

// Last session's credentials, so the first request does not have to wait
// for the page to reveal a token by making one of its own.
//
// Measured against a HAR: the page's first tokened request goes out 0.297s
// after the document loads, but the reskin is only injected at
// onPageFinished — well after that — so it then waits for the *next* one.
// The token survives page loads (two separately captured sessions share
// one), so keeping it is worth a try on the next launch.
//
// Purely an optimistic head start. Sniffing still runs, and a rejected
// token costs one wasted request that callAura retries with the sniffed
// value — never an error the user sees.
const AUTH_KEY = 'flame-aura-auth';

function loadStoredAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || !saved.context || !saved.token) return;
    auraState.context = saved.context;
    auraState.token = saved.token;
    // userId is derived from the account, not the session — safe to reuse
    // even when the token turns out to be stale.
    if (saved.userId) auraState.userId = saved.userId;
  } catch (e) {
    // Unreadable or from an older shape: fall back to sniffing, which is
    // exactly the behaviour before any of this existed.
  }
}

function storeAuth() {
  try {
    if (!auraState.context || !auraState.token) return;
    localStorage.setItem(AUTH_KEY, JSON.stringify({
      context: auraState.context,
      token: auraState.token,
      userId: auraState.userId,
    }));
  } catch (e) {}
}

function forgetStoredAuth() {
  try { localStorage.removeItem(AUTH_KEY); } catch (e) {}
}

loadStoredAuth();

function harvestFromBody(bodyStr) {
  if (!bodyStr || bodyStr.indexOf('aura.context') === -1) return;
  try {
    const params = new URLSearchParams(bodyStr);
    const ctx = params.get('aura.context');
    const tok = params.get('aura.token');
    const changed = ctx !== auraState.context || tok !== auraState.token;
    if (ctx) auraState.context = ctx;
    if (tok) auraState.token = tok;
    if (changed && auraState.context && auraState.token) storeAuth();

    const message = params.get('message');
    if (message) {
      const parsed = JSON.parse(message);
      for (const action of parsed.actions || []) {
        const p = action.params && action.params.params;
        if (p && p.userId && !auraState.userId) {
          auraState.userId = p.userId;
        }
      }
    }
  } catch (e) {
    // best-effort sniffing, ignore malformed bodies
  }
}

// fetch()
const nativeFetch = window.fetch;
window.fetch = function (input, init) {
  try {
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && url.indexOf('/s/sfsites/aura') !== -1 && init && init.body) {
      harvestFromBody(init.body);
    }
  } catch (e) {}
  return nativeFetch.apply(this, arguments);
};

// XMLHttpRequest
const nativeOpen = XMLHttpRequest.prototype.open;
const nativeSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url) {
  this.__reskinUrl = url;
  return nativeOpen.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function (body) {
  try {
    if (this.__reskinUrl && this.__reskinUrl.indexOf('/s/sfsites/aura') !== -1) {
      harvestFromBody(body);
    }
  } catch (e) {}
  return nativeSend.apply(this, arguments);
};

export function waitFor(predicate, timeoutMs = 15000, intervalMs = 150) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for aura context'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// getCurrentUserContactId returns a Contact Id (003-prefix) — NOT usable
// here, the Apex methods below want a User Id (005-prefix). The only
// mapped no-arg call that surfaces the User Id is the AI assistant's
// thread context string, so scrape it out of there instead. Also carries
// additionalKnowledgeFileIds, which Gyan's own chat calls need — cache the
// raw response once and let both consumers share it.
let assistantContextCache = null;
export async function getAssistantContext() {
  if (!assistantContextCache) {
    assistantContextCache = await callAura('AiAssistantFlameCommunityWrapper', 'getAssistantContext', null, true);
  }
  return assistantContextCache;
}

export async function resolveUserId() {
  if (auraState.userId) return auraState.userId;
  const ctx = await getAssistantContext();
  const match = /005[A-Za-z0-9]{12,15}/.exec(ctx.threadContext || '');
  if (!match) throw new Error('could not resolve Salesforce User Id from assistant context');
  auraState.userId = match[0];
  return auraState.userId;
}

// ---------------------------------------------------------------------
// 2. callAura() — the RPC helper
// ---------------------------------------------------------------------

let actionCounter = 0;

export async function callAura(classname, method, params = null, cacheable = false, namespace = '') {
  try {
    return await sendAura(classname, method, params, cacheable, namespace);
  } catch (e) {
    // One retry, and only for the case this exists to cover: the stored
    // credentials were stale. sendAura has already cleared them, so the
    // wait below blocks until the page's own traffic supplies a live
    // token — which it does within a second of the document loading.
    if (!e || !e.frInvalidToken) throw e;
    // The residual risk this whole optimisation carries: the stored token
    // is dead, so we now need a sniffed one, and sniffing only sees
    // requests made *after* the reskin was injected. The page does keep
    // making them, but on the rare launch where a token has expired this
    // is a wait the old always-sniff path never had. 8s rather than the
    // 15s default so a bad case fails visibly instead of looking hung.
    //
    // Injecting the script at document-start would remove this entirely —
    // the hooks would then be in place before the page's own first
    // request, which a HAR puts at 0.297s after the document loads.
    await waitFor(() => auraState.context && auraState.token, 8000);
    return await sendAura(classname, method, params, cacheable, namespace);
  }
}

async function sendAura(classname, method, params = null, cacheable = false, namespace = '') {
  // Preview/dev hook: when a static preview page defines this global,
  // short-circuit the network entirely and resolve canned data. Never
  // set on the real portal, so this is inert in production.
  if (window.__FLAME_RESKIN_PREVIEW__) {
    const key = `${classname}.${method}`;
    const stub = window.__FLAME_RESKIN_PREVIEW__[key];
    if (stub === undefined) throw new Error(`no preview stub for ${key}`);
    // The harness raises this to simulate a slow link, which is the only
    // way to observe what is on screen *while* a request is in flight —
    // the whole point of Home's stale-first paint.
    await new Promise((r) => setTimeout(r, window.__FLAME_RESKIN_PREVIEW_DELAY__ || 80));
    return typeof stub === 'function' ? stub(params) : stub;
  }

  await waitFor(() => auraState.context && auraState.token);

  const id = String(actionCounter++);
  const innerParams = {
    namespace,
    classname,
    method,
    cacheable,
    isContinuation: false,
  };
  // Real requests omit the "params" key entirely for no-arg methods
  // (confirmed against HAR) — sending {} instead trips Apex deserialization.
  if (params) innerParams.params = params;

  const message = {
    actions: [
      {
        id,
        descriptor: 'aura://ApexActionController/ACTION$execute',
        callingDescriptor: 'UNKNOWN',
        params: innerParams,
      },
    ],
  };

  const body = new URLSearchParams({
    message: JSON.stringify(message),
    'aura.context': auraState.context,
    'aura.token': auraState.token,
    'aura.pageURI': location.pathname + location.search,
  });

  const r = Date.now(); // request counter — value doesn't matter, just needs to change (per HANDOFF.md)
  const resp = await nativeFetch(`/s/sfsites/aura?r=${r}&aura.ApexAction.execute=1`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await resp.json();
  const action = (json.actions || []).find((a) => a.id === id) || (json.actions || [])[0];

  if (!action) throw new Error('no matching action in aura response');

  if (action.state === 'SUCCESS') {
    // Aura wraps the Apex return value one level deep:
    // action.returnValue = { returnValue: <actual data>, cacheable: bool }
    // (confirmed against a real HAR response body) — unwrap it here.
    return action.returnValue.returnValue;
  }

  // Token likely rotated — clear it so the next native page request
  // (or a manual reload) repopulates auraState, then surface the error.
  const err = new Error(`aura call failed (${classname}.${method}): ${JSON.stringify(action.error || action)}`);
  if (JSON.stringify(action).indexOf('INVALID_TOKEN') !== -1) {
    auraState.token = null;
    // Drop the stored copy too, or every launch would start by spending a
    // request on the same dead token.
    forgetStoredAuth();
    err.frInvalidToken = true;
  }
  throw err;
}
