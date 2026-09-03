// ---------------------------------------------------------------------
// 14. Gyan — the portal's own AI assistant, talked to via the same Aura
//     RPC endpoint (namespace "vnai" instead of the usual ""). Real
//     backend actions (menu/faculty lookups, bookings) run server-side —
//     confirmed against a captured "book a gym slot via chat" session
//     where the chat's own booking call hit the identical refusal path
//     CustomBookingController.createReservation does. The client's job is
//     only to relay each requiredAction's already-computed functionResponse
//     back as a toolResponse until a real text reply comes back.
// ---------------------------------------------------------------------

import { callAura, getAssistantContext, resolveUserId } from '../aura.js';
import { el } from '../dom.js';
import { renderEmpty, switchTab } from '../shell.js';
import { ui } from '../state.js';

const gyanState = {
  ready: false,
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
  // The composer's submit handler calls runGyanTurn() directly on every
  // send — it only went through ensureGyanReady() once, on tab mount.
  // (Originally caught a bug this way: something had nulled gyanState's
  // threadId between sends and nothing repopulated it before the next
  // runAssistant call went out.) ensureGyanReady() already no-ops once
  // ready, so calling it on every turn is cheap and guards against that
  // class of bug regardless of what clears the state in the future.
  await ensureGyanReady();

  // runModeration's rejection shape was never observed live (nothing got
  // flagged in the captured session) — fail open rather than block the
  // user's message on an unknown error shape.
  try {
    await callAura('AiAssistantWindowController', 'runModeration', { message }, false, 'vnai');
  } catch (e) {
    console.warn('[flame-reskin] gyan moderation check failed, sending anyway', e);
  }

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

export async function renderGyan(token) {
  await ensureGyanReady();
  if (token !== ui.activeToken) return;

  const page = el('div', { class: 'fr-page fr-gyan-page' });
  const headerRow = el('div', { class: 'fr-group-heading-row' });
  headerRow.appendChild(el('h1', { class: 'fr-page-title', text: gyanState.displayName, style: 'margin: 0;' }));
  const newChatBtn = el('button', { class: 'fr-link-btn', type: 'button', text: 'New chat' });
  newChatBtn.addEventListener('click', async () => {
    // deleteThread + acquireGyanThread's createNewThread fallback is now
    // a confirmed-real delete-and-recreate (see acquireGyanThread) — a
    // HAR of the stock UI's "End chat" button showed deleteThread really
    // deletes, and a HAR of "Start chat" showed createNewThread is the
    // real (and only) way to get a new one back afterward. Earlier this
    // called deleteThread with no working recreate path at all, which
    // was genuinely dangerous; that's fixed now.
    newChatBtn.disabled = true;
    const oldThreadId = gyanState.threadId;
    gyanState.messages = [];
    gyanState.threadId = null;
    gyanState.ready = false;
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
  const sendBtn = el('button', { class: 'fr-btn fr-btn--primary', type: 'submit', text: 'Send' });
  composerForm.append(inputEl, sendBtn);

  function paintMessages() {
    inputEl.disabled = gyanState.sending;
    sendBtn.disabled = gyanState.sending;
    if (!gyanState.messages.length && !gyanState.sending) {
      messagesEl.replaceChildren(
        renderEmpty('sparkle', gyanState.welcomeMessage || 'Ask Gyan',
          gyanState.introductionText || 'Ask about classes, bookings, campus info, or anything else Gyan can help with.')
      );
      return;
    }
    const list = el('div', { class: 'fr-gyan-list' });
    for (const m of gyanState.messages) {
      const row = el('div', { class: `fr-gyan-msg fr-gyan-msg--${m.role}` });
      row.appendChild(el('div', { class: 'fr-gyan-bubble', text: m.text }));
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
    // State updates always happen regardless of which tab is showing —
    // only the DOM paint is gated on still being the active view, so
    // switching away mid-reply and back later shows the finished chat
    // instead of getting stuck on "thinking" forever.
    if (token === ui.activeToken) paintMessages();
    try {
      const reply = await runGyanTurn(text);
      gyanState.messages.push({ role: 'assistant', text: reply });
    } catch (err) {
      gyanState.messages.push({ role: 'assistant', text: `Sorry, something went wrong: ${err.message}` });
      // Soft reset only: re-validate on the next attempt (acquireGyanThread
      // looks up the existing thread first and only creates a new one if
      // that lookup genuinely comes back empty — so this never deletes
      // anything, just stops trusting possibly-stale local state). No
      // automatic deleteThread here — that's real and destructive now
      // that createNewThread's recreate path is confirmed working, so it
      // stays an explicit action (the "New chat" button) the user chooses,
      // not something that fires silently on every transient error.
      gyanState.ready = false;
    } finally {
      gyanState.sending = false;
      if (token === ui.activeToken) paintMessages();
    }
  });

  paintMessages();
  page.append(messagesEl, composerForm);
  ui.contentEl.replaceChildren(page);
  inputEl.focus();
}
