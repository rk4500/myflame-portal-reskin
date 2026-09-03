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
