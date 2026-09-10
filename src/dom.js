// A tiny createElement wrapper. Every attribute goes through
// setAttribute except `text`, which sets textContent — so a value is never
// parsed as HTML, and nothing the portal returns can inject markup.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) node.appendChild(child);
  return node;
}

// One shimmering placeholder block, sized in ch because the only thing a
// caller knows is roughly how long the real text will be. It carries a
// non-breaking space so it occupies a real line box of whatever type its
// parent uses — that is what keeps a skeleton row exactly as tall as the
// row it stands in for. See .fr-skel.
export function skel(widthCh) {
  return el('span', { class: 'fr-skel', style: `width: ${widthCh}ch`, text: ' ' });
}

// Animate a container from the height it used to occupy to the height it
// occupies now. Used where a section's contents are rebuilt and the new
// shape is a different size than the old one — the skeleton predicted one
// booking and the day has three — so the section grows into place instead
// of snapping and shoving the page under the reader's eye.
//
// No requestAnimationFrame anywhere in here: this WebView services no
// frames when it decides it has nothing to paint (see HANDOFF), so a rAF
// callback is not a dependable place to put the second height. Reading
// offsetHeight flushes layout synchronously, which is all the transition
// needs to see a start value. For the same reason transitionend is only
// the fast path — a timer clears the inline styles regardless, so a
// dropped transition leaves a correctly sized element rather than one
// frozen at a stale height.
export function morphHeight(node, fromHeight, duration = 280) {
  const to = node.offsetHeight;
  if (!fromHeight || !to || Math.abs(to - fromHeight) < 2) return;
  node.classList.add('fr-morphing');
  node.style.height = `${fromHeight}px`;
  void node.offsetHeight;
  node.style.height = `${to}px`;
  let done = false;
  const clear = () => {
    if (done) return;
    done = true;
    node.classList.remove('fr-morphing');
    node.style.height = '';
  };
  node.addEventListener('transitionend', clear, { once: true });
  setTimeout(clear, duration + 120);
}

// A labelled on/off switch. Returns the row plus a `checked` getter, the
// same minimal surface buildPicker exposes — callers only ever ask it one
// question. Lives here rather than in shell.js so toggle.js (the
// long-press menu) can use it too without shell.js and toggle.js
// importing each other — shell.js already imports from toggle.js, and
// this app has one dependency-cycle war story already (see HANDOFF).
export function buildSwitch({ label, hint, checked = false, onChange }) {
  const row = el('div', { class: 'fr-switch-row' });
  const text = el('div', {}, [el('div', { class: 'fr-switch-label', text: label })]);
  if (hint) text.appendChild(el('p', { class: 'fr-switch-hint', text: hint }));
  const btn = el('button', {
    class: 'fr-switch', type: 'button',
    role: 'switch', 'aria-checked': String(checked), 'aria-pressed': String(checked),
    'aria-label': label,
  });
  btn.appendChild(el('span', { class: 'fr-switch-knob' }));
  let on = checked;
  btn.addEventListener('click', () => {
    on = !on;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-checked', String(on));
    if (onChange) onChange(on);
  });
  row.append(text, btn);
  return { el: row, get checked() { return on; } };
}
