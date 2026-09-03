#!/usr/bin/env node
// Build: src/ -> portal-reskin.user.js -> .patch-tools/hook.js
//
// One command produces both artifacts, because they must not drift:
// hook.js carries the whole userscript as a JSON string constant, and an
// APK built from a stale constant runs the *old* UI while every other
// check on the build still passes.
//
//   npm run build          one-shot
//   npm run watch          same, on every save
//
// portal-reskin.user.js is a committed build output, not a source file:
// it is what gets pasted into Tampermonkey, what preview.html loads, and
// what the GitHub release ships. Edit src/, never that file.
//
// Rollup rather than esbuild, for one reason that matters here: esbuild
// discards ordinary comments (it dropped ~400 lines of them from this
// codebase), and the comments in this project are where every root cause
// in HANDOFF.md ended up. Rollup's output keeps the source's shape, so
// the pasted userscript stays as readable as the modules it came from.

import { rollup, watch as rollupWatch } from 'rollup';
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const USERSCRIPT = join(root, 'portal-reskin.user.js');
const HOOK_SRC = join(root, '.patch-tools', 'hook.src.js');
const HOOK_OUT = join(root, '.patch-tools', 'hook.js');
const watching = process.argv.includes('--watch');

// Byte-identical to what this file has always carried. Tampermonkey reads
// this block, and @run-at document-start is what lets the reskin hide the
// stock chrome before it paints.
const BANNER = `// ==UserScript==
// @name         FLAME Portal Reskin
// @namespace    kaanav.gathani
// @match        https://my.flame.edu.in/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
`;

// The design system is a real .css file so an editor treats it as CSS;
// this hands it to the bundle as a string, which is what the single-file
// version did with a template literal.
const cssAsText = {
  name: 'css-as-text',
  transform(code, id) {
    if (extname(id) !== '.css') return null;
    return { code: `export default ${JSON.stringify(code)};`, map: { mappings: '' } };
  },
};

const inputOptions = { input: join(root, 'src', 'main.js'), plugins: [cssAsText] };
const outputOptions = {
  file: USERSCRIPT,
  format: 'iife',
  banner: BANNER,
  // 'use strict' at the top of the IIFE, as the hand-written version had.
  strict: true,
  // Rollup hoists every module into one scope and renames on collision;
  // this keeps each module's code under a comment naming where it came
  // from, so a stack trace or a read-through still locates the source file.
  generatedCode: { constBindings: true },
  indent: '  ',
};

// hook.js embeds the userscript as a JSON string literal. The rest of it is
// real Frida logic and lives in hook.src.js, which is tracked; the fused
// hook.js is not, since 90% of it would be a second copy of the
// userscript's diff in every commit.
async function fuseHook() {
  try {
    await access(HOOK_SRC);
  } catch {
    console.warn(`! ${HOOK_SRC} missing — skipped hook.js (Android build only)`);
    return;
  }
  const [src, userscript] = await Promise.all([
    readFile(HOOK_SRC, 'utf8'),
    readFile(USERSCRIPT, 'utf8'),
  ]);
  // Matched *with* its surrounding quotes, and asserted to appear exactly
  // once. The bare token also appears in hook.src.js's header comment
  // explaining what it is, and an unanchored replace() happily filled that
  // comment with the entire userscript instead, leaving the real constant
  // untouched — a 130KB comment and a hook that injects nothing, with no
  // error anywhere. Count it rather than trust it.
  const PLACEHOLDER = '"__USERSCRIPT__"';
  const hits = src.split(PLACEHOLDER).length - 1;
  if (hits !== 1) {
    throw new Error(`${HOOK_SRC}: expected exactly one ${PLACEHOLDER} to fill, found ${hits}`);
  }
  // JSON.stringify, not a hand-rolled escape: the userscript is full of
  // backslashes, quotes and newlines in both the CSS and the regexes. It
  // supplies its own quotes, so the placeholder's are replaced along with it.
  const fused = src.replace(PLACEHOLDER, () => JSON.stringify(userscript));

  // The whole point of fusing here is that these two cannot drift, so
  // prove it landed rather than assuming a successful write means a
  // correct one.
  if (!fused.includes('flame-reskin-root')) {
    throw new Error('hook.js was written without the userscript in it');
  }
  await writeFile(HOOK_OUT, fused);
  console.log(`  .patch-tools/hook.js   ${fused.length} bytes (userscript ${userscript.length} chars)`);
}

async function buildOnce() {
  const bundle = await rollup(inputOptions);
  await bundle.write(outputOptions);
  await bundle.close();
  const out = await readFile(USERSCRIPT, 'utf8');
  console.log(`  portal-reskin.user.js  ${out.length} bytes, ${out.split('\n').length} lines`);
}

if (watching) {
  const watcher = rollupWatch({ ...inputOptions, output: outputOptions });
  watcher.on('event', (event) => {
    if (event.code === 'ERROR') console.error(event.error);
    if (event.result) event.result.close();
    if (event.code !== 'BUNDLE_END') return;
    // Watch rebuilds the hook too. It was originally skipped here on the
    // assumption it was the expensive half; measured, the fuse is ~1.4ms
    // against rollup's ~45ms, so skipping it bought nothing and left
    // hook.js stale for exactly as long as you were iterating — which is
    // the drift this build exists to prevent.
    fuseHook().catch((e) => console.error(e.message));
    console.log(`rebuilt (${event.duration}ms)`);
  });
  console.log('watching src/ — writes portal-reskin.user.js and .patch-tools/hook.js');
} else {
  await buildOnce();
  await fuseHook();
}
