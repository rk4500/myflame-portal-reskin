import { callAura, getAssistantContext, resolveUserId } from '../aura.js';
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { renderEmpty, switchTab } from '../shell.js';
import { ui } from '../state.js';

const gyanState = {
  ready: false,
  loadingReady: null,
  assistantId: null,
  userId: null,
  threadId: null,
  threadContext: null,
  additionalKnowledgeFileIds: null,
  displayName: 'Gyan',
  welcomeMessage: '',
  introductionText: '',
  messages: [], // { role: 'user' | 'assistant', text }
  sending: false,
};

async function ensureGyanReady() {
  if (gyanState.ready) return;
  if (gyanState.loadingReady) return gyanState.loadingReady;

  gyanState.loadingReady = (async () => {
    try {
      const userId = await resolveUserId();
      const ctx = await getAssistantContext();
      gyanState.userId = userId;
      gyanState.threadContext = ctx.threadContext;
      gyanState.additionalKnowledgeFileIds = ctx.additionalKnowledgeFileIds || [];

      const assistant = await callAura(
        'AiAssistantWindowController', 'getAssistant',
        { assistantName: 'Gyan', recordId: '' }, true, 'vnai'
      );
      gyanState.assistantId = assistant.assistantId;
      gyanState.displayName = assistant.displayName || assistant.name || 'Gyan';
      gyanState.welcomeMessage = assistant.welcomeMessage || '';
      gyanState.introductionText = assistant.introductionText || '';

      gyanState.threadId = await acquireGyanThread(userId);
      gyanState.ready = true;
    } finally {
      gyanState.loadingReady = null;
    }
  })();

  return gyanState.loadingReady;
}

// Busy means "a request this tab owns is actually in flight" — an init
// that already finished and *failed* is not busy, it is a retry waiting to
// happen. Keying the disabled state off gyanState.ready instead was what
// left the tab permanently dead after one failed turn: ready stayed false,
// so Send and New chat were both disabled and nothing ever re-ran init.
function gyanBusy() {
  return gyanState.sending || !!gyanState.loadingReady;
}

// Root cause, finally confirmed via a HAR of the real "Start chat" click:
// getUserThread's createIfNotExists flag is misleading — it never
// actually creates anything, only looks up a thread that already
// exists (comes back `{}` otherwise, regardless of the flag). Real
// creation is a wholly separate method, createNewThread, which the
// stock UI calls only when the lookup comes back empty. Its response is
// the threadId *string itself*, not an object with a .threadId field
// (confirmed from the capture: returnValue is literally
// "thread_0055i00000CwfKqAAJ...", no wrapper). Safe to call whenever a
// thread is missing — deleteThread (fired for real by "New chat" below)
// is a real, working delete, and this is the real, working recreate.
async function acquireGyanThread(userId) {
  const existing = await callAura(
    'AiAssistantWindowController', 'getUserThread',
    { assistantId: gyanState.assistantId, actorId: userId, createIfNotExists: true, refreshToken: 0 },
    true, 'vnai'
  );
  if (existing.threadId) return existing.threadId;

  const newThreadId = await callAura(
    'AiAssistantWindowController', 'createNewThread',
    { assistantId: gyanState.assistantId, assistantName: gyanState.displayName, actorId: userId },
    false, 'vnai'
  );
  if (!newThreadId) throw new Error('Gyan could not create a conversation thread');
  return newThreadId;
}

// A transfer_to_* requiredAction's functionArgs carries a userQuery —
// that becomes the *next* call's top-level message (confirmed against a
// real capture: "book me a gym slot..." transferred through two
// sub-assistants this way before any tool actually ran). Plain tool
// calls (getCurrentDateTime, getResourceAvailability, ...) have no
// userQuery, so the relay just sends an empty message for those.
function extractUserQuery(functionArgsJson) {
  try {
    const parsed = JSON.parse(functionArgsJson);
    return typeof parsed.userQuery === 'string' ? parsed.userQuery : null;
  } catch (e) {
    return null;
  }
}

async function runGyanTurn(message) {
  const currentTurn = (gyanState.activeTurnId = (gyanState.activeTurnId || 0) + 1);
  await ensureGyanReady();
  if (currentTurn !== gyanState.activeTurnId) throw new Error('Gyan turn aborted');

  try {
    await callAura('AiAssistantWindowController', 'runModeration', { message }, false, 'vnai');
  } catch (e) {
    console.warn('[flame-reskin] gyan moderation check failed, sending anyway', e);
  }
  if (currentTurn !== gyanState.activeTurnId) throw new Error('Gyan turn aborted');

  let runRequest = {
    assistantId: gyanState.assistantId,
    actorId: gyanState.userId,
    threadId: gyanState.threadId,
    message,
    threadContext: gyanState.threadContext,
    additionalKnowledgeFileIds: gyanState.additionalKnowledgeFileIds,
  };

  // Capped so a malformed/looping response can't hang the chat forever.
  for (let step = 0; step < 8; step++) {
    const res = await callAura('AiAssistantWindowController', 'runAssistant', { runRequest }, false, 'vnai');
    if (currentTurn !== gyanState.activeTurnId) throw new Error('Gyan turn aborted');

    if (!res.requiredActions || !res.requiredActions.length) {
      return res.text || "Sorry, I didn't get a response for that.";
    }
    const toolResponses = res.requiredActions.map((a) => ({
      name: a.functionName,
      arguments: a.functionArgs,
      callId: a.toolCallId,
      response: a.functionResponse,
    }));
    const transferQuery = res.requiredActions.map((a) => extractUserQuery(a.functionArgs)).find(Boolean);
    const excludeFunctions = res.requiredActions.map((a) => a.excludeTransferFunction).filter(Boolean);
    const transferredFrom = res.requiredActions.map((a) => a.transferredFromAssistantId).find(Boolean);
    runRequest = {
      assistantId: gyanState.assistantId,
      actorId: gyanState.userId,
      threadId: gyanState.threadId,
      message: transferQuery || '',
      toolResponses,
      threadContext: gyanState.threadContext,
      additionalKnowledgeFileIds: gyanState.additionalKnowledgeFileIds,
      excludeFunctions,
      ...(transferredFrom ? { transferredFromAssistantId: transferredFrom } : {}),
    };
  }
  throw new Error('Gyan did not finish responding (too many tool steps)');
}

function getCleanWelcomeTitle() {
  let title = gyanState.welcomeMessage || '';
  if (!title || /start chat/i.test(title)) {
    title = 'Ask Gyan';
  }
  return title;
}

function getCleanWelcomeText() {
  let intro = gyanState.introductionText || '';
  if (!intro || /start chat/i.test(intro)) {
    intro = 'Ask about classes, facility bookings, campus info, or anything else Gyan can help with.';
  }
  return intro;
}

function getSmartGyanChips() {
  const hour = new Date().getHours();
  const chips = [];

  if (hour >= 0 && hour < 11) {
    chips.push({ text: "What's for breakfast today?", label: "Breakfast today", icon: 'utensils' });
    chips.push({ text: "What's for lunch today?", label: "Lunch today", icon: 'utensils' });
  } else if (hour >= 11 && hour < 16) {
    chips.push({ text: "What's for lunch today?", label: "Lunch today", icon: 'utensils' });
    chips.push({ text: "What's for dinner tonight?", label: "Dinner tonight", icon: 'utensils' });
  } else if (hour >= 16 && hour < 19) {
    chips.push({ text: "What's for snacks today?", label: "Snacks today", icon: 'utensils' });
    chips.push({ text: "What's for dinner tonight?", label: "Dinner tonight", icon: 'utensils' });
  } else {
    chips.push({ text: "What's for dinner tonight?", label: "Dinner tonight", icon: 'utensils' });
    chips.push({ text: "What's for breakfast tomorrow?", label: "Tomorrow's breakfast", icon: 'utensils' });
  }

  chips.push({ text: "What is my next class?", label: "Next class", icon: 'calendar' });
  chips.push({ text: "Are sports slots available today?", label: "Sports slots", icon: 'book' });

  return chips;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseGyanBold(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  // Double asterisks **bold**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$2</strong>');
  // Single asterisk *bold*
  html = html.replace(/(^|\s)\*([^\*\n]+)\*(\s|$)/g, '$1<strong>$2</strong>$3');
  return html;
}

export function renderGyan(token) {
  if (token !== ui.activeToken) return;

  const page = el('div', { class: 'fr-page fr-gyan-page' });
  const headerRow = el('div', { class: 'fr-group-heading-row' });
  headerRow.appendChild(el('h1', { class: 'fr-page-title', text: gyanState.displayName, style: 'margin: 0;' }));
  const newChatBtn = el('button', { class: 'fr-link-btn', type: 'button', text: 'New chat' });
  newChatBtn.addEventListener('click', async () => {
    if (gyanBusy()) return;
    newChatBtn.disabled = true;
    gyanState.activeTurnId = (gyanState.activeTurnId || 0) + 1;
    const oldThreadId = gyanState.threadId;
    gyanState.messages = [];
    gyanState.threadId = null;
    gyanState.ready = false;
    paintMessages();
    if (oldThreadId) {
      try {
        await callAura('AiAssistantWindowController', 'deleteThread', { threadId: oldThreadId }, false, 'vnai');
      } catch (e) {
        console.warn('[flame-reskin] failed to delete old gyan thread, continuing anyway', e);
      }
    }
    if (token === ui.activeToken) switchTab('gyan');
  });
  headerRow.appendChild(newChatBtn);
  page.appendChild(headerRow);

  const messagesEl = el('div', { class: 'fr-gyan-messages' });
  const composerForm = el('form', { class: 'fr-gyan-composer' });
  const inputEl = el('input', {
    class: 'fr-input', type: 'text', placeholder: `Ask ${gyanState.displayName}…`, autocomplete: 'off',
  });
  const sendBtn = el('button', { class: 'fr-btn fr-btn--primary', type: 'submit' });
  composerForm.append(inputEl, sendBtn);

  function paintMessages() {
    // Textbox is always interactive (never disabled) so the user can type immediately
    inputEl.disabled = false;

    const isLoading = gyanBusy();
    sendBtn.disabled = isLoading;
    newChatBtn.disabled = isLoading;
    newChatBtn.style.opacity = isLoading ? '0.4' : '1';
    newChatBtn.style.pointerEvents = isLoading ? 'none' : 'auto';
    if (isLoading) {
      sendBtn.classList.add('fr-btn--loading');
      sendBtn.replaceChildren(icon('spinner'));
    } else {
      sendBtn.classList.remove('fr-btn--loading');
      sendBtn.replaceChildren();
      sendBtn.textContent = 'Send';
    }

    if (!gyanState.messages.length && !gyanState.sending) {
      const emptyWrap = el('div', { class: 'fr-gyan-welcome-wrap' });
      const emptyEl = renderEmpty('sparkle', getCleanWelcomeTitle(), getCleanWelcomeText());

      const suggestionsEl = el('div', { class: 'fr-gyan-suggestions' });
      const suggestionsLabel = el('div', { class: 'fr-gyan-suggestions-label', text: 'Suggested questions' });
      const chipsRow = el('div', { class: 'fr-gyan-chips' });

      for (const c of getSmartGyanChips()) {
        const btn = el('button', { class: 'fr-gyan-chip', type: 'button' });
        // A chip submits by dispatching the form event, which does not care
        // that sendBtn is disabled — so the chip has to carry the same
        // disabled state itself, or it fires a turn the composer is refusing.
        btn.disabled = isLoading;
        btn.append(icon(c.icon), document.createTextNode(c.label));
        btn.addEventListener('click', () => {
          if (gyanBusy()) return;
          inputEl.value = c.text;
          composerForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        });
        chipsRow.appendChild(btn);
      }

      suggestionsEl.append(suggestionsLabel, chipsRow);
      emptyWrap.append(emptyEl, suggestionsEl);
      messagesEl.replaceChildren(emptyWrap);
      return;
    }

    const list = el('div', { class: 'fr-gyan-list' });
    for (const m of gyanState.messages) {
      const row = el('div', { class: `fr-gyan-msg fr-gyan-msg--${m.role}` });
      const bubble = el('div', { class: 'fr-gyan-bubble' });
      if (m.role === 'assistant') {
        bubble.innerHTML = parseGyanBold(m.text);
      } else {
        bubble.textContent = m.text;
      }
      row.appendChild(bubble);
      list.appendChild(row);
    }
    if (gyanState.sending) {
      const row = el('div', { class: 'fr-gyan-msg fr-gyan-msg--assistant' });
      row.appendChild(el('div', { class: 'fr-gyan-bubble fr-gyan-typing', text: `${gyanState.displayName} is thinking…` }));
      list.appendChild(row);
    }
    messagesEl.replaceChildren(list);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  composerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text || gyanState.sending) return;
    inputEl.value = '';
    gyanState.messages.push({ role: 'user', text });
    gyanState.sending = true;

    if (token === ui.activeToken) paintMessages();
    try {
      if (!gyanState.ready) {
        await ensureGyanReady();
      }
      const reply = await runGyanTurn(text);
      gyanState.messages.push({ role: 'assistant', text: reply });
    } catch (err) {
      gyanState.messages.push({ role: 'assistant', text: `Sorry, something went wrong: ${err.message}` });
      gyanState.ready = false;
    } finally {
      gyanState.sending = false;
      if (token === ui.activeToken) paintMessages();
    }
  });

  inputEl.addEventListener('focus', () => {
    setTimeout(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 150);
  });

  // Kicked off *before* the first paint: ensureGyanReady sets loadingReady
  // synchronously, so paintMessages already sees the busy state and the very
  // first frame carries the spinner instead of an enabled Send for one tick.
  if (!gyanState.ready) {
    ensureGyanReady().then(() => {
      if (token === ui.activeToken) paintMessages();
    }).catch((err) => {
      console.warn('[flame-reskin] ensureGyanReady background init failed', err);
      if (token === ui.activeToken) paintMessages();
    });
  }

  paintMessages();
  page.append(messagesEl, composerForm);
  ui.contentEl.replaceChildren(page);

  const isMobile = window.innerWidth <= 760 || 'ontouchstart' in window;
  if (!isMobile) {
    inputEl.focus();
  }
}
