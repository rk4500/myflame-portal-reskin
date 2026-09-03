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

function harvestFromBody(bodyStr) {
  if (!bodyStr || bodyStr.indexOf('aura.context') === -1) return;
  try {
    const params = new URLSearchParams(bodyStr);
    const ctx = params.get('aura.context');
    const tok = params.get('aura.token');
    if (ctx) auraState.context = ctx;
    if (tok) auraState.token = tok;

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
  // Preview/dev hook: when a static preview page defines this global,
  // short-circuit the network entirely and resolve canned data. Never
  // set on the real portal, so this is inert in production.
  if (window.__FLAME_RESKIN_PREVIEW__) {
    const key = `${classname}.${method}`;
    const stub = window.__FLAME_RESKIN_PREVIEW__[key];
    if (stub === undefined) throw new Error(`no preview stub for ${key}`);
    await new Promise((r) => setTimeout(r, 80));
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
  if (JSON.stringify(action).indexOf('INVALID_TOKEN') !== -1) {
    auraState.token = null;
  }
  throw new Error(`aura call failed (${classname}.${method}): ${JSON.stringify(action.error || action)}`);
}
