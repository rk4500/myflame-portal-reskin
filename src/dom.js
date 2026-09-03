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
