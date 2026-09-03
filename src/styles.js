// The design system's CSS, injected as one <style> tag.
//
// esbuild's text loader turns the .css file into a string at build time —
// the same thing the single-file version did with a template literal,
// minus the escaping traps (a bare \0 followed by a digit is an illegal
// octal escape in a template literal, which is why .fr-row-meta's
// non-breaking space had to be written '\\00a0' there and can be written
// normally here).

import STYLE_CSS from './styles.css';

export function injectComponentStyles() {
  if (document.getElementById('flame-reskin-styles')) return;
  const style = document.createElement('style');
  style.id = 'flame-reskin-styles';
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
}
