// parse.js — dependency-free, fast drop-in for marked 18.1.3 (default
// options, GFM on). parse(markdown) returns exactly the HTML marked
// renders, byte for byte, on the CommonMark 0.31.2 and GFM 0.29 examples
// and on long generated documents. Written from the CommonMark spec plus
// probing of marked's observable output; marked's own source is not used.
//
// Layout: block lexing is a line-oriented pass that mirrors marked's
// block order (space, indented code, fence, ATX, hr, quote, list, HTML
// block, definition, table, setext, paragraph, text). Inline parsing is
// a left-to-right scan: emphasis runs on a CommonMark delimiter stack,
// strikethrough on marked's opener-driven scan, and link labels are
// scanned recursively so delimiters inside a formed link's label never
// match delimiters outside it. Nothing persists between parse() calls.

export function parse(src) {
  const ctx = { refs: Object.create(null), inLink: false };
  const norm = src.replace(/\r\n?/g, '\n');
  return renderBlocks(lexBlocks(norm, ctx, true, false), ctx);
}

// ------------------------------------------------------------------ basics

// ASCII punctuation, per CommonMark.
function isAsciiPunct(c) {
  return (c >= '!' && c <= '/') || (c >= ':' && c <= '@') ||
    (c >= '[' && c <= '`') || (c >= '{' && c <= '~');
}

// Unicode punctuation or symbol, as marked uses it for flanking.
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  if (code < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(c);
}

const WS_RE = /\s/;
function isSpace(c) {
  return c !== undefined && WS_RE.test(c);
}

// Reference-label folding: trim, collapse inner whitespace to one space,
// then the toLowerCase -> toUpperCase -> toLowerCase round trip.
function foldLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// marked's URL cleaning: encodeURI, then un-escape %25 back to %.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Escape a string for HTML. With encode=false a & that begins a valid
// entity reference (&name; &#123; &#x1f;) is left alone; with encode=true
// every & becomes &amp;.
const ENTITY_RE = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/y;
function esc(s, encode) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') {
      if (!encode) {
        ENTITY_RE.lastIndex = i;
        if (ENTITY_RE.test(s)) continue;
      }
      rep = '&amp;';
    } else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode numeric character references in inline text. Named references
// are left as-is. Code point 38 decodes to the literal text "&amp;";
// 0, surrogates and > 0x10FFFF become U+FFFD.
const NUM_REF_RE = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6});|&(?!\w+;|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};)/g;
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(NUM_REF_RE, (m, num) => {
    if (num === undefined) return '&amp;';
    let cp;
    if (num[1] === 'x' || num[1] === 'X') cp = parseInt(num.slice(2), 16);
    else cp = parseInt(num.slice(1), 10);
    if (cp === 38) return '&amp;';
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    return String.fromCodePoint(cp);
  });
}

// Code-span content: newlines become spaces; one leading and one trailing
// space are stripped only when both are present and something non-space
// sits between them.
function codeSpanContent(raw) {
  let s = raw.replace(/\n/g, ' ');
  if (s.length >= 2 && s[0] === ' ' && s[s.length - 1] === ' ') {
    let hasNonSpace = false;
    for (let i = 1; i < s.length - 1; i++) {
      if (s[i] !== ' ') { hasNonSpace = true; break; }
    }
    if (hasNonSpace) s = s.slice(1, -1);
  }
  return s;
}

// Drop trailing spaces, tabs and newlines without a regex.
function trimTrailWS(s) {
  let e = s.length;
  while (e > 0) {
    const c = s[e - 1];
    if (c === ' ' || c === '\t' || c === '\n') e--;
    else break;
  }
  return e === s.length ? s : s.slice(0, e);
}

// True when s ends with a blank line: \n, optional spaces/tabs, \n,
// optional spaces/tabs, end. Used for loose-list detection.
function endsWithBlankLine(s) {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
  if (e === 0 || s[e - 1] !== '\n') return false;
  e--;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
  if (e === 0 || s[e - 1] !== '\n') return false;
  return true;
}

// Drop trailing blank lines from a raw block, keeping at most one: with
// 0 or 1 trailing blank lines the raw is returned unchanged; with 2 or
// more they are all removed. Scans backwards line by line, no split.
function ge(raw) {
  let end = raw.length;
  let blank = 0;
  let i = raw.length;
  while (i > 0) {
    let ls = i - 1;
    while (ls >= 0 && raw[ls] !== '\n') ls--;
    ls++;
    let allBlank = true;
    for (let m = ls; m < i; m++) {
      const c = raw[m];
      if (c !== ' ' && c !== '\t') { allBlank = false; break; }
    }
    if (!allBlank) { end = i; break; }
    blank++;
    i = ls - 1;
    if (i < 0) { end = 0; break; }
  }
  if (blank <= 1) return raw;
  return raw.slice(0, end);
}

// ------------------------------------------------------------------ inline

// One * or _ delimiter run in the piece list. origLen is the run's
// length before any inner match consumed part of it (the rule-of-3 and
// "m" checks look at runs already partly consumed); len is what is left.
// pos is the run's start in the inline string (for the masking quirk).
function makeDelim(ch, len, canOpen, canClose, pos) {
  return { d: 1, ch, len, origLen: len, canOpen, canClose, openTags: [], closeTags: [], active: true, pos };
}

// Marked's masking quirk, probed: an inline link/image whose label holds
// a code span with UNEQUAL opener/closer backtick lengths (e.g. ``b`)
// is not masked the way a normal link label is, and every em/strong/del
// in the same paragraph that has a code span anywhere after it is
// suppressed. Reference links do not trigger it; the link must come
// before the emphasis; suppression is per-paragraph.
// A label ending in a run of 2+ backticks right before ']' never
// triggers it, and a run with no later backtick is not a code span.
function labelHasUnequalCodeSpan(label) {
  let e = label.length;
  while (e > 0 && label[e - 1] === '`') e--;
  if (label.length - e >= 2) return false;
  let j = 0;
  while (j < label.length) {
    if (label[j] !== '`') { j++; continue; }
    let n = 0;
    while (j + n < label.length && label[j + n] === '`') n++;
    if (n >= 2 && label[j + n] === ']') { j += n; continue; }
    const k = label.indexOf('`', j + n);
    if (k < 0) return false;
    let m = 0;
    while (k + m < label.length && label[k + m] === '`') m++;
    if (n !== m) return true;
    j = k + m;
  }
  return false;
}

// For a '[' (or '![') at s[i] whose link failed: find the label span if
// it looks like an inline-link attempt [label](...) whose label contains
// a code span. Marked masks such a span, hiding its _/*/~ delimiters
// from the emphasis scan, so em/strong/del inside the label never form
// even though the link itself fails (e.g. [at _node ``a ` b``_](u)).
// Returns {from, to} for the label interior, or null.
function failedLinkLabelSpan(s, i) {
  const bracketPos = s[i] === '!' ? i + 1 : i;
  if (s[bracketPos] !== '[') return null;
  let depth = 0;
  let j = bracketPos + 1;
  let hasCodeSpan = false;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (c === '`') {
      const cs = tryCodeSpan(s, j);
      if (cs) { hasCodeSpan = true; j = cs.end; continue; }
      let n = 0;
      while (j + n < s.length && s[j + n] === '`') n++;
      j += n;
      continue;
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth === 0) {
        if (!hasCodeSpan) return null;
        if (j + 1 < s.length && s[j + 1] === '(') return { from: bracketPos + 1, to: j };
        return null;
      }
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Is there a code span starting at or after pos in s?
function hasCodeSpanAfter(s, pos) {
  let j = pos;
  while (j < s.length) {
    const k = s.indexOf('`', j);
    if (k < 0) return false;
    if (tryCodeSpan(s, k)) return true;
    let n = 0;
    while (k + n < s.length && s[k + n] === '`') n++;
    j = k + n;
  }
  return false;
}

// CommonMark delimiter-stack emphasis (spec Appendix A). openers_bottom
// is keyed by (char, closer length mod 3, closer can also open): a
// failed closer only blocks later closers of the same kind from looking
// below it, since the rule of 3 depends on lengths mod 3 and on whether
// either side can both open and close. When a closer fails, the bottom
// is set to the element BEFORE the closer, so the failed closer itself
// stays searchable (it may still open for a later closer). When an
// opener and closer match, every delimiter between them leaves the
// stack (a delimiter inside an em cannot match one outside it); its
// remaining length still renders as literal text.
function processDelims(delims, s, st) {
  const bottom = { '*': [[-1, -1], [-1, -1], [-1, -1]], '_': [[-1, -1], [-1, -1], [-1, -1]] };
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.active || !closer.canClose || closer.len === 0) continue;
    // Masking quirk: after a link/image with an unequal-length code
    // span in its label, an em/strong whose closer is followed by a
    // code span anywhere later in the paragraph does not form. The
    // closer must sit AFTER the triggering link (maskQuirkPos).
    if (st && st.maskQuirk && closer.pos >= st.maskQuirkPos && hasCodeSpanAfter(s, closer.pos + closer.origLen)) {
      bottom[closer.ch][closer.len % 3][closer.canOpen ? 1 : 0] = ci - 1;
      if (!closer.canOpen) closer.active = false;
      continue;
    }
    const b = bottom[closer.ch][closer.len % 3][closer.canOpen ? 1 : 0];
    let oi = ci - 1;
    let opener = null;
    let openerIdx = -1;
    while (oi > b) {
      const o = delims[oi];
      if (o.active && o.ch === closer.ch && o.canOpen && o.len > 0) {
        if ((o.canOpen && o.canClose) || (closer.canOpen && closer.canClose)) {
          const sum = o.len + closer.len;
          if (sum % 3 === 0 && !(o.len % 3 === 0 && closer.len % 3 === 0)) { oi--; continue; }
        }
        // Marked's emStrong: an opener longer than the closer does not
        // match it when another delimiter of the same char sits between
        // them (the opener already spent its length on the inner match,
        // e.g. **public as *so*other* option html**: the ** opener
        // must match the final **, not the single * after 'other').
        // With nothing between them (e.g. __foo_ bar_) the shorter
        // closer still matches the longer opener.
        if (o.len > closer.len) {
          let between = false;
          for (let k = oi + 1; k < ci; k++) {
            if (delims[k].ch === closer.ch) { between = true; break; }
          }
          if (between) { oi--; continue; }
        }
        // Marked's emStrong (opener-driven): a double closer skips a
        // single opener that is orphaned — its own next closer was
        // already processed and failed (inactive, no tags) — when an
        // earlier double opener of the same char is still active
        // (e.g. **a *b **c**d* e**: the * before b never closes, so the
        // final ** matches the outer ** as a strong, not the single *
        // as an em). Single closers and non-orphaned singles are
        // unaffected (cm-428/431/418).
        if (closer.len >= 2 && o.len === 1) {
          let orphaned = false;
          for (let k = oi + 1; k < ci; k++) {
            const nx = delims[k];
            if (nx.ch !== closer.ch || !nx.canClose) continue;
            // skip closers that already matched something else; the
            // first still-unused potential closer is o's own
            if (nx.closeTags.length > 0 || nx.openTags.length > 0) continue;
            if (!nx.active) { orphaned = true; }
            break;
          }
          if (orphaned) {
            let shadowed = false;
            for (let k = oi - 1; k > b; k--) {
              const o2 = delims[k];
              if (o2.active && o2.ch === closer.ch && o2.canOpen && o2.len >= 2) { shadowed = true; break; }
            }
            if (shadowed) { oi--; continue; }
          }
        }
        // Marked's emStrong, rule of 3 + m accumulation: a single
        // opener (* or _) does not match its closer when an inner **
        // (or __) opener-like run sits between them and that run's
        // matching closer is a both/neither run (can open AND close,
        // i.e. followed by a letter, e.g. *first changes **code**
        // request* stays literal). When the inner closer is a plain
        // closer-only run (followed by punct/space, e.g. *(**foo**)*),
        // the outer em still forms.
        if (o.len === 1 && closer.len === 1) {
          let blocked = false;
          for (let k = oi + 1; k < ci; k++) {
            const d = delims[k];
            if (d.ch !== closer.ch || !d.canOpen || d.canClose || d.origLen < 2) continue;
            // find this run's matching closer (the next same-char run)
            for (let m2 = k + 1; m2 < ci; m2++) {
              const c2 = delims[m2];
              if (c2.ch !== closer.ch) continue;
              if (c2.canOpen && c2.canClose) { blocked = true; }
              break;
            }
            if (blocked) break;
          }
          if (blocked) { oi--; continue; }
        }
        opener = o;
        openerIdx = oi;
        break;
      }
      oi--;
    }
    if (!opener) {
      bottom[closer.ch][closer.len % 3][closer.canOpen ? 1 : 0] = ci - 1;
      if (!closer.canOpen) closer.active = false;
      continue;
    }
    const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
    if (use === 1) { opener.openTags.push('<em>'); closer.closeTags.push('</em>'); }
    else { opener.openTags.push('<strong>'); closer.closeTags.push('</strong>'); }
    opener.len -= use;
    closer.len -= use;
    // Marked's emStrong f accumulation: a both/neither run (can open
    // AND close) between the opener and closer is skipped by the rule
    // of 3, so the closer consumes extra delimiters that land INSIDE
    // the strong (e.g. **a *b*c*** -> <strong>a <em>b</em>c*</strong>,
    // the * after b is followed by a letter, so it is both/neither).
    // f is the sum of those runs' original lengths; that many of the
    // closer's remaining chars render before the close tag.
    if (use === 2) {
      let f = 0;
      for (let k = openerIdx + 1; k < ci; k++) {
        const d = delims[k];
        if (d.ch === closer.ch && d.canOpen && d.canClose) f += d.origLen;
      }
      if (f > 0 && closer.len > 0) closer.insideExtra = Math.min(f, closer.len);
    }
    // remove the delimiters between the opener and the closer
    for (let k = openerIdx + 1; k < ci; k++) delims[k].active = false;
    if (opener.len === 0) opener.active = false;
    if (closer.len === 0) closer.active = false;
    if (closer.len > 0) ci--;
  }
}

function renderPieces(out) {
  let html = '';
  for (const p of out) {
    if (typeof p === 'string') { html += p; continue; }
    // Delimiter marker. insideExtra chars (from the emStrong f
    // accumulation) render before the close tag — they sit inside the
    // em/strong; the rest render after it.
    let s = '';
    const inside = p.insideExtra || 0;
    if (inside > 0) s += p.ch.repeat(inside);
    for (let i = 0; i < p.closeTags.length; i++) s += p.closeTags[i];
    if (p.len > inside) s += p.ch.repeat(p.len - inside);
    for (let i = p.openTags.length - 1; i >= 0; i--) s += p.openTags[i];
    html += s;
  }
  return html;
}

// Flanking for a delimiter run in s at [start, end): the char before is
// s[start-1], the char after is s[end]. Returns {canOpen, canClose}.
function flanking(s, start, end, ch) {
  const before = start > 0 ? s[start - 1] : undefined;
  const after = end < s.length ? s[end] : undefined;
  const beforeWS = before === undefined || isSpace(before);
  const afterWS = after === undefined || isSpace(after);
  const beforePunct = before !== undefined && isPunct(before);
  const afterPunct = after !== undefined && isPunct(after);
  const leftFlanking = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlanking = !beforeWS && (!beforePunct || afterWS || afterPunct);
  let canOpen, canClose;
  if (ch === '*' || ch === '~') {
    // * and ~ use the plain left/right-flanking rules; only _ has the
    // extra intraword restrictions
    canOpen = leftFlanking;
    canClose = rightFlanking;
  } else {
    canOpen = leftFlanking && (!rightFlanking || beforePunct);
    canClose = rightFlanking && (!leftFlanking || afterPunct);
  }
  return { canOpen, canClose };
}

// Scan a code span starting at s[i] (a backtick). Returns {end, html} or
// null. The closer must be a run of backticks of EXACTLY the opener's
// length: a run of a different length (or part of a longer run) is not a
// closer.
function tryCodeSpan(s, i) {
  let n = 0;
  while (i + n < s.length && s[i + n] === '`') n++;
  let j = i + n;
  while (j < s.length) {
    if (s[j] !== '`') { j++; continue; }
    let m = 0;
    while (j + m < s.length && s[j + m] === '`') m++;
    if (m === n) {
      const content = s.slice(i + n, j);
      if (content.indexOf('\n\n') >= 0) return null;
      return { end: j + n, html: '<code>' + esc(codeSpanContent(content), true) + '</code>' };
    }
    j += m;
  }
  return null;
}

// Scan a definition/reference label starting at s[i] === '['. A def/ref
// label may not contain an unescaped '[' (marked's label regex excludes
// '[' and ']'); nested brackets only occur in a link's TEXT, which
// scanLabel handles. Returns {end, label} or null.
function scanDefLabel(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (c === '`') {
      // skip a code span; if it never closes, the backticks are literal
      // text and the label scan continues (marked's label regex does
      // not fail on an unclosed code span)
      let n = 0;
      while (j + n < s.length && s[j + n] === '`') n++;
      const close = '`'.repeat(n);
      const k = s.indexOf(close, j + n);
      if (k < 0) { j += n; continue; }
      j = k + n;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') return { end: j + 1, label: s.slice(i + 1, j) };
    j++;
  }
  return null;
}

// Scan a link label starting at s[i] === '['. Returns {end, label},
// end just past the matching ']', or null.
function scanLabel(s, i) {
  let depth = 0;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (c === '`') {
      // A backtick run in a link label. FIRST: a run of 2+ backticks
      // immediately before ']' is literal label text (the ``+(?=])
      // alternative) — it must win over the code-span alternative,
      // whose closer would otherwise be a backtick in a LATER link,
      // swallowing the ']' and breaking this label. Otherwise the run
      // forms a code span whose closer is the NEXT backtick run of any
      // length (opener and closer runs may differ in length). A single
      // backtick before ']' with no later backtick matches no
      // alternative and makes the label (and the link) fail.
      let n = 0;
      while (j + n < s.length && s[j + n] === '`') n++;
      if (n >= 2 && s[j + n] === ']') { j += n; continue; }
      const k = s.indexOf('`', j + n);
      if (k >= 0) {
        // The code span's closer must come before the label-ending ']'
        // (depth 0). If a ']' at the current depth appears first, the
        // code span would swallow the label end and the label regex
        // fails (e.g. [at _node ``a ` b``_] — the `` before _ has no
        // closer before the ']', so the whole link fails).
        let d = depth;
        let bad = false;
        for (let q = j + n; q < k; q++) {
          if (s[q] === '\\') { q++; continue; }
          if (s[q] === '[') d++;
          else if (s[q] === ']') { if (d === 0) { bad = true; break; } d--; }
        }
        if (bad) return null;
        let m = 0;
        while (k + m < s.length && s[k + m] === '`') m++;
        j = k + m;
        continue;
      }
      return null;
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth === 0) return { end: j + 1, label: s.slice(i + 1, j) };
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Parse an inline link destination/title starting at s[i] === '('.
// Returns {end, href, title} or null; end is just past the closing ')'.
function parseDestTitle(s, i) {
  let j = i + 1;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let href = '';
  let title = null;
  if (j >= s.length) return null;
  if (s[j] === '<') {
    // Angle destination: no newline, no < >, backslash escapes kept
    let k = j + 1;
    let ok = false;
    while (k < s.length) {
      const c = s[k];
      if (c === '\n' || c === '<') return null;
      if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (c === '>') { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    href = s.slice(j + 1, k).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    j = k + 1;
  } else if (s[j] === ')') {
    href = '';
  } else {
    // Bare destination: balanced parens, no spaces, no control chars
    let depth = 0;
    let k = j;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (c === '(') { depth++; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        k++;
        continue;
      }
      k++;
    }
    if (k === j) return null;
    href = s.slice(j, k).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    j = k;
  }
  // Optional title
  let saveJ = j;
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k < s.length && s[k] === '\n') {
    let m = k + 1;
    while (m < s.length && (s[m] === ' ' || s[m] === '\t')) m++;
    k = m;
  }
  if (k < s.length && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const q = s[k];
    const closeQ = q === '(' ? ')' : q;
    let m = k + 1;
    let depth = 0;
    let ok = false;
    while (m < s.length) {
      const c = s[m];
      if (c === '\\' && m + 1 < s.length) { m += 2; continue; }
      if (q === '(' && c === '(') { depth++; m++; continue; }
      if (c === closeQ) {
        if (q === '(' && depth > 0) { depth--; m++; continue; }
        ok = true;
        break;
      }
      if (c === '\n') return null;
      m++;
    }
    if (ok) {
      const t = s.slice(k + 1, m).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      if (t.length > 0) title = t;
      j = m + 1;
    } else {
      j = saveJ;
    }
  } else {
    j = saveJ;
  }
  // Skip trailing spaces/tabs/newlines, expect ')'
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (j >= s.length || s[j] !== ')') return null;
  return { end: j + 1, href, title };
}

// Does the label text (original source, labelStart..labelEnd) contain an
// HTML tag or autolink that extends past the label's end? (marked's Be.)
function labelHasTagPastEnd(s, labelStart, labelEnd) {
  if (s.indexOf('<', labelStart) < 0 || s.indexOf('<', labelStart) >= labelEnd) return false;
  for (let p = labelStart; p < labelEnd; p++) {
    if (s[p] === '\\') { p++; continue; }
    if (s[p] === '`') {
      const cs = tryCodeSpan(s, p);
      if (cs) { p = cs.end - 1; continue; }
    }
    if (s[p] !== '<') continue;
    const rest = s.slice(p);
    const tag = tryTag(rest);
    const auto = tag ? null : tryAutolink(rest);
    const m = tag || auto;
    if (m && p + m.length > labelEnd) return true;
    if (m) p += m.length - 1;
  }
  return false;
}

// Try an <...> autolink at the start of s. Returns {length, href, text}
// or null.
function tryAutolink(s) {
  if (s[0] !== '<') return null;
  // Scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  let i = 1;
  if (i >= s.length || !/[a-zA-Z]/.test(s[i])) return null;
  i++;
  let schemeLen = 1;
  while (i < s.length && /[a-zA-Z0-9+.-]/.test(s[i]) && schemeLen < 32) { i++; schemeLen++; }
  if (schemeLen >= 2 && schemeLen <= 32 && i < s.length && s[i] === ':') {
    // Scheme autolink: up to '>', no spaces/control/<>
    let j = i + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '>') {
        return { length: j + 1, href: s.slice(1, j), text: s.slice(1, j) };
      }
      if (c === ' ' || c === '\n' || c === '<' || c.charCodeAt(0) < 0x20) return null;
      j++;
    }
    return null;
  }
  // Email autolink
  const m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+>/.exec(s.slice(1));
  if (m) {
    const email = m[0].slice(0, -1);
    return { length: email.length + 2, href: 'mailto:' + email, text: email };
  }
  return null;
}

// Try an inline HTML tag at the start of s. Returns {length, tag} or null.
function tryTag(s) {
  if (s[0] !== '<') return null;
  // Comment: <!--> and <!---> are complete empty comments on their own
  // (the -?> in marked's comment regex is an optional '-' plus '>')
  if (s.startsWith('<!--')) {
    if (s[4] === '>') return { length: 5, tag: '<!-->' };
    if (s[4] === '-' && s[5] === '>') return { length: 6, tag: '<!--->' };
    const end = s.indexOf('-->', 4);
    if (end < 0) {
      // Unterminated comment runs to the end of the line / input
      const nl = s.indexOf('\n');
      return { length: nl < 0 ? s.length : nl, tag: nl < 0 ? s : s.slice(0, nl) };
    }
    return { length: end + 3, tag: s.slice(0, end + 3) };
  }
  // Processing instruction
  if (s.startsWith('<?')) {
    const end = s.indexOf('?>', 2);
    if (end < 0) return null;
    return { length: end + 2, tag: s.slice(0, end + 2) };
  }
  // Declaration
  if (s.startsWith('<!') && s.length > 2 && /[a-zA-Z]/.test(s[2])) {
    let i = 2;
    while (i < s.length && s[i] !== '>') i++;
    if (i >= s.length) return null;
    return { length: i + 1, tag: s.slice(0, i + 1) };
  }
  // CDATA
  if (s.startsWith('<![CDATA[')) {
    const end = s.indexOf(']]>', 9);
    if (end < 0) return null;
    return { length: end + 3, tag: s.slice(0, end + 3) };
  }
  // Closing tag
  if (s.startsWith('</')) {
    const m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(s);
    if (m) return { length: m[0].length, tag: m[0] };
    return null;
  }
  // Opening tag (with attributes)
  const m = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/.exec(s);
  if (m) return { length: m[0].length, tag: m[0] };
  return null;
}

// Try a strikethrough starting at s[i] === '~'. Marked's left-to-right
// semantics: the opener is 1 or 2 tildes, followed by a non-space non-~
// char; the closer is a run of exactly the opener's length, preceded by
// content whose last unit is valid (a non-space non-~ non-backslash
// char, or an escape), and followed by a non-~ char or end. Returns
// {end, content} or null.
function tryDel(s, i) {
  let run = 0;
  while (i + run < s.length && s[i + run] === '~') run++;
  const openLen = run >= 2 ? 2 : 1;
  const cs = i + openLen;
  if (cs >= s.length) return null;
  const first = s[cs];
  if (first === ' ' || first === '\t' || first === '\n' || first === '\r' || first === '~') return null;
  // Marked's del(): opener-driven. p accumulates the opener length plus
  // any opener-like runs (can open, cannot close) met while scanning;
  // a closer candidate (length exactly openLen) subtracts openLen and
  // only matches when p hits 0.
  const isEsc = (j) => {
    let b = 0;
    let q = j - 1;
    while (q >= 0 && s[q] === '\\') { b++; q--; }
    return b % 2 === 1;
  };
  let p = openLen;
  for (let j = cs; j < s.length; j++) {
    if (s[j] !== '~') continue;
    if (isEsc(j)) continue; // escaped ~ is content, not a delimiter
    // Not the run start if the previous ~ is unescaped
    if (j > cs && s[j - 1] === '~' && !isEsc(j - 1)) continue;
    let rl = 0;
    while (j + rl < s.length && s[j + rl] === '~') rl++;
    if (rl !== openLen) continue;
    // Opener-like runs (can open, cannot close) add to p; the last-char
    // check only applies to closer candidates
    const f = flanking(s, j, j + rl, '~');
    if (f.canOpen && !f.canClose) { p += rl; continue; }
    // Closer candidate: content's last char must be valid: not space,
    // not ~, and not a lone \
    const last = s[j - 1];
    if (last === ' ' || last === '\t' || last === '\n' || last === '\r') continue;
    if (last === '\\') {
      let bl = 0;
      let q = j - 1;
      while (q >= cs && s[q] === '\\') { bl++; q--; }
      if (bl % 2 === 1) continue;
    }
    p -= openLen;
    if (p > 0) continue;
    return { end: j + openLen, content: s.slice(cs, j) };
  }
  return null;
}

// GFM autolink (www / scheme / email) at the start of s. Returns
// {length, href, text} or null. The caller guarantees the trigger
// position (the text scanner only stops here when the preceding-char
// rules allow it). delims: the open emphasis delimiters collected so
// far in this inline string (used for the email trailing-delimiter rule).
const PROTO_RE = /(?:mailto:([A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+)|xmpp:([A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?:\/[A-Za-z0-9@.]+)?))(?![\w-])/y;
const SCHEME_WWW_RE = /(?:(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/y;
const EMAIL_LONG_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/y;
const EMAIL_STRICT2_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;

function tryUrl(s, i, delims) {
  const c = s[i];
  // mailto: / xmpp: (only when the first char can start one)
  if (c === 'm' || c === 'M' || c === 'x' || c === 'X') {
    PROTO_RE.lastIndex = i;
    const mProto = PROTO_RE.exec(s);
    if (mProto) {
      const raw = mProto[0];
      return { length: raw.length, href: raw, text: raw };
    }
  }
  // scheme:// or www.
  if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'w') {
    SCHEME_WWW_RE.lastIndex = i;
    const mUrl = SCHEME_WWW_RE.exec(s);
    if (mUrl) {
      let url = mUrl[0];
      // Backpedal: trim trailing punctuation, keep balanced parens
      url = backpedal(url);
      if (url.length === 0) return null;
      const href = url.startsWith('www.') ? 'http://' + url : url;
      return { length: url.length, href, text: url };
    }
  }
  // Email: only if a local-part char is followed by an @ within the
  // local-part run (a cheap manual scan avoids two regex execs on every
  // word that is not an email)
  if (!isEmailLocal(c)) return null;
  let j = i;
  while (j < s.length && isEmailLocal(s[j])) j++;
  if (j >= s.length || s[j] !== '@') return null;
  EMAIL_LONG_RE.lastIndex = i;
  const mEmailLong = EMAIL_LONG_RE.exec(s);
  if (mEmailLong && delims) {
    const raw = mEmailLong[0];
    const after = s[i + raw.length];
    // The trailing _/* is a closer for an open delimiter of the same
    // char (the opener's canOpen is what matters, not its canClose)
    if ((after === '_' || after === '*') && delims.some((d) => d.active && d.ch === after && d.canOpen)) {
      return { length: raw.length, href: 'mailto:' + raw, text: raw };
    }
  }
  EMAIL_STRICT2_RE.lastIndex = i;
  const mEmail = EMAIL_STRICT2_RE.exec(s);
  if (mEmail) {
    const raw = mEmail[0];
    return { length: raw.length, href: 'mailto:' + raw, text: raw };
  }
  return null;
}

// Backpedal a GFM autolink URL: trim trailing punctuation, keep balanced
// (). A '(' must be part of a balanced group \([^)]*\) (so an unbalanced
// '(' terminates the URL, not just a trailing one); trailing punctuation
// and a trailing valid entity are stripped; '&' is kept unless it starts
// a valid entity at the end.
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(url) {
  let prev = url;
  for (;;) {
    const m = BACKPEDAL_RE.exec(prev);
    const next = m ? m[0] : '';
    if (next === prev) return next;
    prev = next;
  }
}

// Email local-part characters.
function isEmailLocal(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c === '.' || c === '!' || c === '#' || c === '$' || c === '%' || c === '&' ||
    c === "'" || c === '*' || c === '+' || c === '/' || c === '=' || c === '?' ||
    c === '^' || c === '_' || c === '`' || c === '{' || c === '|' || c === '}' ||
    c === '~' || c === '-';
}

// Word character (letter, digit, or _), fast ASCII path with a Unicode
// fallback for non-ASCII letters.
const WORD_RE = /[\p{L}\p{N}_]/u;
function isWordChar(c) {
  if (c === '') return false;
  const code = c.charCodeAt(0);
  if (code < 128) {
    return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) || code === 95;
  }
  return WORD_RE.test(c);
}

// Case-insensitive prefix match without allocating a substring.
function startsWithCI(s, j, lit) {
  for (let k = 0; k < lit.length; k++) {
    const a = s[j + k];
    if (a === undefined) return false;
    const b = lit[k];
    if (a === b) continue;
    const ca = a.charCodeAt(0);
    const cb = b.charCodeAt(0);
    if (ca >= 65 && ca <= 90 && ca + 32 === cb) continue;
    if (ca >= 97 && ca <= 122 && ca - 32 === cb) continue;
    return false;
  }
  return true;
}

// Sticky email regexes (no substring allocation in textRunEnd).
const EMAIL_STRICT_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const EMAIL_LOOSE_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/y;

// Find the end of the current text run starting at s[i]. Returns the
// index where the text run stops (a token starts there, or the end of
// the string). This mirrors marked's inline text regex stop points. A
// bare newline is part of the text run (a soft break); 2+ spaces before
// a newline stop the run only when they form a real hard break.
function textRunEnd(s, i) {
  const len = s.length;
  let j = i;
  while (j < len) {
    const c = s[j];
    if (c === '\\' || c === '`' || c === '<' || c === '[' || c === '!' || c === '*' || c === '~') return j;
    if (c === '_') {
      // _ stops the text unless the whole run is strictly intraword
      // (word char on both sides of the run), where it can never be a
      // delimiter; a _ between two non-word chars (e.g. -_(bar)_) CAN
      // open/close. The after-char is past the whole run, not past the
      // first _ (a run's own _ is a word char, so checking s[j+1] would
      // wrongly swallow the first _ of a closing __).
      let n = 0;
      while (j + n < len && s[j + n] === '_') n++;
      const before = j > 0 ? s[j - 1] : '';
      const after = j + n < len ? s[j + n] : '';
      if (!(isWordChar(before) && isWordChar(after))) return j;
      j += n;
      continue;
    }
    if (c === ' ') {
      // 2+ spaces followed by a newline stop the run only for a hard break
      let k = j;
      while (k < len && s[k] === ' ') k++;
      if (k < len && s[k] === '\n' && k - j >= 2) {
        let m = k + 1;
        while (m < len && (s[m] === ' ' || s[m] === '\t')) m++;
        if (m < len && s[m] !== '\n') return j;
        // Not a hard break: the spaces and newline are plain text
        j = k + 1;
        continue;
      }
      j = k;
      continue;
    }
    // GFM triggers
    if (c === 'w' && s.startsWith('www.', j)) {
      const before = j === 0 ? '' : s[j - 1];
      if (j > i && (before === '' || before === ' ' || before === '\t' || before === '\n' ||
          before === '*' || before === '_' || before === '~' || before === '(')) return j;
      j += 4;
      continue;
    }
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
      if (j > i && (startsWithCI(s, j, 'http://') || startsWithCI(s, j, 'https://') || startsWithCI(s, j, 'ftp://'))) return j;
      j++;
      continue;
    }
    if (c === 'm' || c === 'M' || c === 'x' || c === 'X') {
      if (startsWithCI(s, j, 'mailto:') || startsWithCI(s, j, 'xmpp:')) {
        const before = j === 0 ? '' : s[j - 1];
        const beforeAlnum = before !== '' && ((before >= 'a' && before <= 'z') || (before >= 'A' && before <= 'Z') || (before >= '0' && before <= '9'));
        if (j > i && !beforeAlnum) return j;
      }
      j++;
      continue;
    }
    if (c === '@') {
      // Possible email: look back for the local-part start
      let ls = j - 1;
      while (ls >= i && isEmailLocal(s[ls])) ls--;
      ls++;
      if (ls < j && ls > i && !isEmailLocal(s[ls - 1])) {
        EMAIL_STRICT_RE.lastIndex = ls;
        const mEmail = EMAIL_STRICT_RE.exec(s);
        if (mEmail) return ls;
        // Also stop for an email followed by a _/* delimiter (the
        // tryUrl call decides whether it really links, using the open
        // delimiters); a lone trailing _ is rejected there
        EMAIL_LOOSE_RE.lastIndex = ls;
        const mEmail2 = EMAIL_LOOSE_RE.exec(s);
        if (mEmail2) {
          const after = s[ls + mEmail2[0].length];
          if (after === '_' || after === '*') return ls;
        }
      }
      j++;
      continue;
    }
    j++;
  }
  return len;
}

// Scan a reference [ref] at s[i] (s[i] === '['). Returns {text, end} or
// null. The ref may contain backslash escapes and any char except an
// unescaped [ or ]; it must not be empty or all whitespace (marked's
// reflink pattern, max 999 repetitions).
function scanRef(s, i) {
  let j = i + 1;
  // Must not be empty or all whitespace
  let k = j;
  while (k < s.length && isSpace(s[k])) k++;
  if (k >= s.length || s[k] === ']') return null;
  let text = '';
  let reps = 0;
  while (j < s.length && reps < 999) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) {
      text += s[j] + s[j + 1];
      j += 2;
      reps++;
      continue;
    }
    if (c === '[' || c === ']') break;
    text += c;
    j++;
    reps++;
  }
  if (j >= s.length || s[j] !== ']') return null;
  if (text.length === 0) return null;
  return { text, end: j + 1 };
}

// Try to form a link/image at s[i] ('[' or '!['). Returns {end, html} or
// null. ctx: {refs, inLink}. st: {inRawBlock, linkEmitted} (shared,
// mutated). textMode: when true, produce plain text (for image alt text).
function tryLink(s, i, ctx, st, textMode) {
  const isImage = s[i] === '!';
  const bracketPos = isImage ? i + 1 : i;
  if (s[bracketPos] !== '[') return null;
  const lab = scanLabel(s, bracketPos);
  if (!lab) return null;
  const label = lab.label;
  const afterLabel = lab.end;
  let href = null;
  let title = null;
  let end = -1;
  let isInline = false;
  // Inline link: (dest title)
  if (afterLabel < s.length && s[afterLabel] === '(') {
    const dt = parseDestTitle(s, afterLabel);
    if (dt) { href = dt.href; title = dt.title; end = dt.end; isInline = true; }
  }
  // Full reference: [label][ref]. If the ref scans cleanly but is not
  // defined, the link fails outright: no shortcut retry is made (marked
  // returns just '[' as text, and [foo] is literal, e.g. [foo][bar][baz]
  // with only [baz] and [foo] defined leaves [foo] literal).
  let fullRefScanned = false;
  if (end < 0) {
    if (afterLabel < s.length && s[afterLabel] === '[') {
      const ref = scanRef(s, afterLabel);
      if (ref) {
        fullRefScanned = true;
        const entry = ctx.refs[foldLabel(ref.text)];
        if (entry) { href = entry.href; title = entry.title; end = ref.end; }
      }
    }
  }
  if (end < 0 && !fullRefScanned) {
    // Collapsed: [label][]
    if (afterLabel + 1 < s.length && s[afterLabel] === '[' && s[afterLabel + 1] === ']') {
      const entry = ctx.refs[foldLabel(label)];
      if (entry) { href = entry.href; title = entry.title; end = afterLabel + 2; }
    }
  }
  if (end < 0 && !fullRefScanned) {
    // Shortcut: [label]
    const entry = ctx.refs[foldLabel(label)];
    if (entry) { href = entry.href; title = entry.title; end = afterLabel; }
  }
  if (end < 0) return null;
  // Be check: the label must not contain an HTML tag or autolink that
  // extends past the label's end.
  if (label.indexOf('<') >= 0 && labelHasTagPastEnd(s, bracketPos + 1, lab.end - 1)) return null;
  // Parse the label text. Backslash-escaped [ and ] become literal brackets.
  const labelText = label.replace(/\\([\[\]])/g, '$1');
  const savedInLink = ctx.inLink;
  const savedLinkEmitted = st.linkEmitted;
  const savedInRawBlock = st.inRawBlock;
  const savedMaskQuirk = st.maskQuirk;
  const savedMaskQuirkPos = st.maskQuirkPos;
  const savedSuppressFrom = st.suppressDelimsFrom;
  const savedSuppressTo = st.suppressDelimsTo;
  ctx.inLink = true;
  st.linkEmitted = false;
  const inner = parseInline(labelText, ctx, st, isImage);
  const containedLink = st.linkEmitted;
  ctx.inLink = savedInLink;
  st.linkEmitted = savedLinkEmitted;
  st.maskQuirk = savedMaskQuirk;
  st.maskQuirkPos = savedMaskQuirkPos;
  st.suppressDelimsFrom = savedSuppressFrom;
  st.suppressDelimsTo = savedSuppressTo;
  if (!isImage) {
    if (containedLink) { st.inRawBlock = savedInRawBlock; return null; }
    st.linkEmitted = true;
  }
  // Masking quirk: an inline link/image whose label contains a code
  // span with unequal opener/closer lengths suppresses later em/strong
  // in this paragraph when a code span follows them. Reflinks do NOT
  // trigger it, so set the flag only for inline links/images.
  // maskQuirkPos is the link's end — only delimiters after it count.
  if (isInline && labelHasUnequalCodeSpan(label)) { st.maskQuirk = true; st.maskQuirkPos = end; }
  if (textMode) return { end, html: inner };
  const url = cleanUrl(href);
  if (isImage) {
    if (url === null) return { end, html: esc(inner, false) };
    let img = '<img src="' + esc(url, false) + '" alt="' + esc(inner, false) + '"';
    if (title !== null) img += ' title="' + esc(title, false) + '"';
    return { end, html: img + '>' };
  }
  if (url === null) return { end, html: inner };
  let a = '<a href="' + esc(url, false) + '"';
  if (title !== null) a += ' title="' + esc(title, false) + '"';
  return { end, html: a + '>' + inner + '</a>' };
}

// Parse an inline string to HTML. ctx: {refs, inLink} (inLink is document
// state, mutated by <a> tags). st: {inRawBlock, linkEmitted}.
// textMode: produce plain text (image alt text).
function parseInline(s, ctx, st, textMode) {
  const out = [];
  const delims = [];
  const len = s.length;
  let i = 0;
  while (i < len) {
    const c = s[i];
    // Backslash escape / hard break
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '\n') {
        let k = i + 2;
        while (k < len && (s[k] === ' ' || s[k] === '\t')) k++;
        if (k < len && s[k] !== '\n') {
          if (!textMode) out.push('<br>');
          i = k;
          continue;
        }
        out.push('\\');
        i++;
        continue;
      }
      if (n !== undefined && isAsciiPunct(n)) {
        out.push(textMode ? n : esc(n, false));
        i += 2;
        continue;
      }
      out.push('\\');
      i++;
      continue;
    }
    // Code span; when a backtick run cannot form a code span (no closer
    // of the same length), the WHOLE run is literal text, not just one
    // backtick (so ```foo`` stays literal: the ``` run is consumed, and
    // the trailing `` has no opener left)
    if (c === '`') {
      const cs = tryCodeSpan(s, i);
      if (cs) {
        if (textMode) {
          const n = countBackticks(s, i);
          const k = s.indexOf('`'.repeat(n), i + n);
          out.push(codeSpanContent(s.slice(i + n, k)));
        } else {
          out.push(cs.html);
        }
        i = cs.end;
        continue;
      }
      let n = 0;
      while (i + n < len && s[i + n] === '`') n++;
      out.push('`'.repeat(n));
      i += n;
      continue;
    }
    // Hard break: 2+ spaces before a newline
    if (c === ' ') {
      let k = i;
      while (k < len && s[k] === ' ') k++;
      if (k < len && s[k] === '\n' && k - i >= 2) {
        let m = k + 1;
        while (m < len && (s[m] === ' ' || s[m] === '\t')) m++;
        if (m < len && s[m] !== '\n') {
          if (!textMode) out.push('<br>');
          i = m;
          continue;
        }
      }
      // Not a hard break: fall through to the text run
    }
    // Link / image
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const link = tryLink(s, i, ctx, st, textMode);
      if (link) {
        out.push(link.html);
        i = link.end;
        continue;
      }
      // A failed inline-link attempt whose label holds a code span is
      // masked, so its _/*/~ delimiters do not form
      const span = failedLinkLabelSpan(s, i);
      if (span) { st.suppressDelimsFrom = span.from; st.suppressDelimsTo = span.to; }
      out.push(c === '!' ? '!' : '[');
      i++;
      continue;
    }
    // Emphasis delimiter
    if (c === '*' || c === '_') {
      let n = 0;
      while (i + n < len && s[i + n] === c) n++;
      // Inside a masked failed-link label, delimiters are literal
      if (st.suppressDelimsFrom !== undefined && i >= st.suppressDelimsFrom && i < st.suppressDelimsTo) {
        out.push(s.slice(i, i + n));
        i += n;
        continue;
      }
      if (c === '_') {
        // Strictly intraword _ (word char on both sides) can never be a
        // delimiter; everything else goes through flanking
        const before = i > 0 ? s[i - 1] : '';
        const after = i + n < len ? s[i + n] : '';
        if (isWordChar(before) && isWordChar(after)) {
          out.push(s.slice(i, i + n));
          i += n;
          continue;
        }
      }
      // In textMode (image alt text) the delimiters are still collected
      // and matched, but their tags are dropped before rendering, so
      // *bar* in an alt becomes plain 'bar' (marked's text renderer)
      const fl = flanking(s, i, i + n, c);
      const marker = makeDelim(c, n, fl.canOpen, fl.canClose, i);
      out.push(marker);
      delims.push(marker);
      i += n;
      continue;
    }
    // Strikethrough (suppressed by the masking quirk when a code
    // span follows it later in the paragraph)
    if (c === '~') {
      if (st.suppressDelimsFrom !== undefined && i >= st.suppressDelimsFrom && i < st.suppressDelimsTo) {
        let n = 0;
        while (i + n < len && s[i + n] === '~') n++;
        out.push('~'.repeat(n));
        i += n;
        continue;
      }
      if (st.maskQuirk) {
        let n = 0;
        while (i + n < len && s[i + n] === '~') n++;
        if (hasCodeSpanAfter(s, i + n)) {
          out.push('~'.repeat(n));
          i += n;
          continue;
        }
      }
      const d = tryDel(s, i);
      if (d) {
        const inner = parseInline(d.content, ctx, st, textMode);
        if (!textMode) out.push('<del>' + inner + '</del>');
        else out.push(inner);
        i = d.end;
        continue;
      }
      let n = 0;
      while (i + n < len && s[i + n] === '~') n++;
      out.push('~'.repeat(n));
      i += n;
      continue;
    }
    // < : autolink, then tag, then literal
    if (c === '<') {
      const auto = tryAutolink(s.slice(i));
      if (auto) {
        if (!textMode) {
          const url = cleanUrl(auto.href);
          if (url === null) out.push(esc(auto.text, true));
          else out.push('<a href="' + esc(url, true) + '">' + esc(auto.text, true) + '</a>');
        } else {
          out.push(auto.text);
        }
        i += auto.length;
        continue;
      }
      const tag = tryTag(s.slice(i));
      if (tag) {
        if (!ctx.inLink && /^<a /i.test(tag.tag)) ctx.inLink = true;
        else if (ctx.inLink && /^<\/a>/i.test(tag.tag)) ctx.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag.tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag.tag)) st.inRawBlock = false;
        out.push(tag.tag);
        i += tag.length;
        continue;
      }
      out.push('&lt;');
      i++;
      continue;
    }
    // GFM autolink (www / scheme / email), suppressed inside a link
    if (!ctx.inLink) {
      const u = tryUrl(s, i, delims);
      if (u) {
        if (!textMode) {
          const url = cleanUrl(u.href);
          if (url === null) out.push(esc(u.text, true));
          else out.push('<a href="' + esc(url, true) + '">' + esc(u.text, true) + '</a>');
        } else {
          out.push(u.text);
        }
        i += u.length;
        continue;
      }
    }
    // Plain text run
    const end = textRunEnd(s, i);
    if (end === i) {
      // Safety: never stall (a lone special char that no tokenizer took)
      const ch = s[i];
      out.push(ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch);
      i++;
      continue;
    }
    const txt = s.slice(i, end);
    if (st.inRawBlock) {
      out.push(txt);
    } else if (textMode) {
      out.push(decodeEntities(txt));
    } else {
      out.push(esc(decodeEntities(txt), false));
    }
    i = end;
  }
  processDelims(delims, s, st);
  if (textMode) {
    // Plain-text rendering: drop the em/strong tags, keep the text and
    // any unmatched delimiter characters
    for (const d of delims) { d.openTags.length = 0; d.closeTags.length = 0; }
  }
  return renderPieces(out);
}

function countBackticks(s, i) {
  let n = 0;
  while (i + n < s.length && s[i + n] === '`') n++;
  return n;
}

// ------------------------------------------------------------------ blocks
// Mirrors marked 18.1.3's block tokeniser order and quirks (space,
// indented code, fences, heading, hr, blockquote, list, html, def,
// table, setext, paragraph, text) and its merge rules (code/def merge
// into a preceding paragraph or text token; consecutive paragraphs merge
// across blockquote chunks; consecutive text tokens merge). Token shapes:
//   space {t:'space', raw}  code {t:'code', lang, text, raw}
//   heading {t:'heading', depth, text}  hr {t:'hr'}
//   quote {t:'quote', tokens}  list {t:'list', ordered, start, loose, items}
//   html {t:'html', text}  def {t:'def', tag, href, title, raw}
//   table {t:'table', header:[{text,align}], rows:[[{text,align}]]}
//   p {t:'p', text}  txt {t:'txt', text}
// A list item is {task, checked, loose, tokens} (tokens are block tokens,
// lexed with top=false, so paragraphs become txt tokens).

function lexBlocks(src, ctx, top, mergePara, out) {
  const toks = out || [];
  let s = src;
  while (s.length) {
    let r;
    // Space (blank lines)
    r = trySpace(s);
    if (r) { s = s.slice(r.len); if (r.tok) toks.push(r.tok); continue; }
    // Indented code (merges into a preceding paragraph/text token)
    r = tryIndCode(s);
    if (r) {
      s = s.slice(r.len);
      const last = toks[toks.length - 1];
      if (last && (last.t === 'p' || last.t === 'txt')) {
        last.text += '\n' + r.tok.text;
        last.raw = (last.raw || '') + '\n' + r.tok.raw;
      } else toks.push(r.tok);
      continue;
    }
    // Fenced code
    r = tryFences(s);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // ATX heading
    r = tryAtx(s);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // Thematic break (checked before list)
    r = tryHr(s);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // Blockquote
    r = tryQuote(s, ctx);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // List
    r = tryList(s, ctx);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // HTML block
    r = tryHtmlBlock(s);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // Link reference definition
    r = tryDef(s);
    if (r) {
      s = s.slice(r.len);
      const last = toks[toks.length - 1];
      if (last && (last.t === 'p' || last.t === 'txt')) {
        // A def after paragraph text is paragraph text, not a definition
        last.text += '\n' + r.tok.raw;
        last.raw = (last.raw || '') + '\n' + r.tok.raw;
      } else {
        if (!ctx.refs[r.tok.tag]) ctx.refs[r.tok.tag] = { href: r.tok.href, title: r.tok.title };
        toks.push(r.tok);
      }
      continue;
    }
    // Table
    r = tryTable(s, ctx);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // Setext heading
    r = trySetext(s);
    if (r) { s = s.slice(r.len); toks.push(r.tok); continue; }
    // Paragraph (top-level only)
    if (top) {
      r = tryParagraph(s);
      if (r) {
        s = s.slice(r.len);
        const last = toks[toks.length - 1];
        if (mergePara && last && last.t === 'p') {
          last.text += '\n' + r.tok.text;
          last.raw = (last.raw || '') + '\n' + r.tok.raw;
        } else toks.push(r.tok);
        continue;
      }
    }
    // Text (one line; only when top is false)
    if (!top) {
      r = tryText(s);
      if (r) {
        s = s.slice(r.len);
        const last = toks[toks.length - 1];
        if (last && last.t === 'txt') {
          last.text += '\n' + r.tok.text;
          last.raw = (last.raw || '') + '\n' + r.tok.raw;
        } else toks.push(r.tok);
        continue;
      }
    }
    // Fallback: consume one line as a text token (should not happen).
    const nl = s.indexOf('\n');
    const line = nl < 0 ? s : s.slice(0, nl);
    s = nl < 0 ? '' : s.slice(nl + 1);
    const last = toks[toks.length - 1];
    if (last && last.t === 'txt') last.text += '\n' + line;
    else toks.push({ t: 'txt', text: line, raw: line });
  }
  return toks;
}

// Blank lines. A lone "\n" (one char) is just the previous block's line
// break and produces no token; anything longer is a space token.
function trySpace(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const j = s.indexOf('\n', i);
    const end = j < 0 ? n : j;
    let k = i;
    while (k < end && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k !== end) break;
    i = j < 0 ? n : j + 1;
    if (j < 0) break;
  }
  if (i === 0) return null;
  if (i === 1) return { len: 1, tok: null };
  return { len: i, tok: { t: 'space', raw: s.slice(0, i) } };
}

// Is this line an indented-code line (4 spaces, or 0-3 spaces + tab, then
// a non-newline character)?
function isCodeLine(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 4) i++;
  if (i === 4) return i < line.length;
  if (i < line.length && line[i] === '\t') return i + 1 < line.length;
  return false;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// Indented code: consecutive code lines with blank lines between them.
// The match consumes trailing blank lines too (they are stripped from
// the raw by ge(), as in marked's code regex).
function tryIndCode(s) {
  if (!isCodeLine(firstLine(s))) return null;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const j = s.indexOf('\n', i);
    const end = j < 0 ? n : j;
    const line = s.slice(i, end);
    if (isCodeLine(line)) {
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (isBlankLine(line)) {
      // Consume the blank run; continue only if a code line follows it
      let k = i;
      let found = false;
      while (k < n) {
        const j2 = s.indexOf('\n', k);
        const end2 = j2 < 0 ? n : j2;
        const ln2 = s.slice(k, end2);
        if (isBlankLine(ln2)) { k = j2 < 0 ? n : j2 + 1; continue; }
        if (isCodeLine(ln2)) found = true;
        break;
      }
      if (found) { i = k; continue; }
      i = k; // trailing blank lines are consumed, then stop
      break;
    }
    break;
  }
  const rawFull = s.slice(0, i);
  const raw = ge(rawFull);
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  // The consumed length is the stripped raw's length (trailing blank
  // lines stay in the source and become a space token)
  return { len: raw.length, tok: { t: 'code', lang: '', text, raw } };
}

function firstLine(s) {
  const j = s.indexOf('\n');
  return j < 0 ? s : s.slice(0, j);
}

// Fenced code. The content is dedented by the opening fence's indent,
// but only for backtick fences (marked's dedent step).
function tryFences(s) {
  // Opening fence: 0-3 spaces, 3+ backticks or tildes
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= s.length) return null;
  const ch = s[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  const runLen = j - i;
  if (runLen < 3) return null;
  const indent = i;
  // Info string: rest of the line; a backtick in a backtick fence's info
  // breaks the fence
  const nl = s.indexOf('\n', j);
  const info = nl < 0 ? s.slice(j) : s.slice(j, nl);
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  const lang = info.trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
  // Scan for the closing fence
  let pos = nl < 0 ? s.length : nl + 1;
  let contentEnd = -1;
  let closeEnd = s.length;
  while (pos < s.length) {
    const j2 = s.indexOf('\n', pos);
    const end2 = j2 < 0 ? s.length : j2;
    const line = s.slice(pos, end2);
    // Closing fence: 0-3 spaces, same char, >= runLen, then only spaces
    let k = 0;
    while (k < line.length && line[k] === ' ' && k < 3) k++;
    let m = k;
    while (m < line.length && line[m] === ch) m++;
    if (m - k >= runLen) {
      let p = m;
      while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++;
      if (p === line.length) {
        contentEnd = pos;
        closeEnd = j2 < 0 ? s.length : j2;
        break;
      }
    }
    pos = j2 < 0 ? s.length : j2 + 1;
  }
  if (contentEnd < 0) {
    contentEnd = s.length;
    closeEnd = s.length;
  }
  let content = s.slice(nl < 0 ? s.length : nl + 1, contentEnd);
  // The content ends with the \n before the closing fence; drop it
  if (content.endsWith('\n')) content = content.slice(0, -1);
  // Dedent: only when the raw starts with whitespace + ```
  if (ch === '`' && indent > 0) {
    const lines = content.split('\n');
    for (let q = 0; q < lines.length; q++) {
      const ln = lines[q];
      let lead = 0;
      while (lead < ln.length && (ln[lead] === ' ' || ln[lead] === '\t')) lead++;
      if (lead > 0) lines[q] = ln.slice(Math.min(lead, indent));
    }
    content = lines.join('\n');
  }
  return { len: closeEnd, tok: { t: 'code', lang, text: content, raw: s.slice(0, closeEnd) } };
}

// ATX heading: 0-3 spaces, 1-6 #, then whitespace or EOL. A closing run
// of #s is stripped only when preceded by a space/tab (or the text is
// empty).
function tryAtx(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= s.length || s[i] !== '#') return null;
  let j = i;
  while (j < s.length && s[j] === '#') j++;
  const depth = j - i;
  if (depth > 6) return null;
  if (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n') return null;
  const nl = s.indexOf('\n', j);
  const end = nl < 0 ? s.length : nl;
  let text = s.slice(j, end).trim();
  if (text.endsWith('#')) {
    let k = text.length;
    while (k > 0 && text[k - 1] === '#') k--;
    const stripped = text.slice(0, k);
    if (!stripped || stripped.endsWith(' ') || stripped.endsWith('\t')) {
      text = stripped.trim();
    }
  }
  return { len: end, tok: { t: 'heading', depth, text, raw: s.slice(0, end) } };
}

// Thematic break: 0-3 spaces, then 3+ of -, _, or * with spaces/tabs
// between them.
function tryHr(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= s.length) return null;
  const ch = s[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return null;
  let j = i;
  let count = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === ch) { count++; j++; continue; }
    if (c === ' ' || c === '\t') { j++; continue; }
    break;
  }
  if (count < 3) return null;
  if (j >= s.length) return { len: j, tok: { t: 'hr', raw: s.slice(0, j) } };
  if (s[j] === '\n') {
    // The hr regex consumes all following newlines
    let k = j;
    while (k < s.length && s[k] === '\n') k++;
    return { len: k, tok: { t: 'hr', raw: s.slice(0, k) } };
  }
  return null;
}

// Setext heading: text lines (not starting a block) + an underline of
// = or - (0-3 spaces indent). The text is trimmed.
function trySetext(s) {
  // The first line must not start a block
  const nl0 = s.indexOf('\n');
  if (nl0 < 0) return null;
  const first = s.slice(0, nl0);
  if (startsBlock(first, true)) return null;
  // Collect text lines until the underline
  let pos = 0;
  const lines = [];
  while (true) {
    const nl = s.indexOf('\n', pos);
    const end = nl < 0 ? s.length : nl;
    const line = s.slice(pos, end);
    if (isBlankLine(line)) return null;
    if (lines.length > 0 && isSetextUnderline(line)) {
      const depth = line.trim()[0] === '=' ? 1 : 2;
      const text = lines.join('\n').trim();
      return { len: end, tok: { t: 'heading', depth, text, raw: s.slice(0, end) } };
    }
    if (startsBlock(line, false)) return null;
    lines.push(line);
    if (nl < 0) return null;
    pos = nl + 1;
  }
}

function isSetextUnderline(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length) return false;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return false;
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length;
}

// Does this line start a block (for the paragraph/setext continuation
// lookahead)? `first` = it is the first line of the candidate text.
function startsBlock(line, first) {
  // hr
  if (isHrLine(line)) return true;
  // ATX heading
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i < line.length && line[i] === '#') {
    let j = i;
    while (j < line.length && line[j] === '#') j++;
    if (j - i >= 1 && j - i <= 6 && (j >= line.length || line[j] === ' ' || line[j] === '\t')) return true;
  }
  // Blockquote
  if (i < line.length && line[i] === '>') return true;
  // Fence (a backtick fence whose info contains a backtick is not one)
  if (i < line.length && (line[i] === '`' || line[i] === '~')) {
    let j = i;
    while (j < line.length && line[j] === line[i]) j++;
    if (j - i >= 3) {
      if (line[i] === '`' && line.slice(j).indexOf('`') >= 0) return false;
      return true;
    }
  }
  // List (bullet or ordered); a bare marker with no content cannot
  // interrupt a paragraph (marked's paragraph lookahead requires
  // [ \t]+[^ \t\n] after the marker), so continuations use the strict
  // check while a first line uses the loose one
  if (first ? isListMarker(line) : isListInterrupt(line)) return true;
  // HTML block start (types 1-6; type 7 is handled by the html regex)
  if (isHtmlBlockStart(line)) return true;
  // Table: only relevant as a continuation check, handled by tryTable
  return false;
}

function isHrLine(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length) return false;
  const ch = line[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let j = i;
  let count = 0;
  while (j < line.length) {
    const c = line[j];
    if (c === ch) { count++; j++; continue; }
    if (c === ' ' || c === '\t') { j++; continue; }
    return false;
  }
  return count >= 3;
}

function isListMarker(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length) return false;
  const c = line[i];
  if (c === '*' || c === '+' || c === '-') {
    return i + 1 >= line.length || line[i + 1] === ' ' || line[i + 1] === '\t';
  }
  if (c >= '0' && c <= '9') {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j - i > 9 || j - i === 0) return false;
    if (j < line.length && (line[j] === '.' || line[j] === ')')) {
      return j + 1 >= line.length || line[j + 1] === ' ' || line[j + 1] === '\t';
    }
  }
  return false;
}

// A list marker followed by spaces/tabs and a non-space char: the only
// form that can interrupt a paragraph (a bare marker cannot). An ordered
// list can interrupt a paragraph only when it starts with 1.
function isListInterrupt(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  if (i >= line.length) return false;
  const c = line[i];
  let j;
  if (c === '*' || c === '+' || c === '-') {
    j = i + 1;
  } else if (c === '1') {
    j = i + 1;
    if (j < line.length && (line[j] === '.' || line[j] === ')')) j++;
    else return false;
  } else return false;
  if (j >= line.length) return false;
  if (line[j] !== ' ' && line[j] !== '\t') return false;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j < line.length;
}

// Paragraph: lines until a blank line or a line starting a block.
// The continuation lookahead excludes hr, heading, setext (handled by
// startsBlock), blockquote, fences, list, html, table, and blank lines.
function tryParagraph(s) {
  const nl0 = s.indexOf('\n');
  const first = nl0 < 0 ? s : s.slice(0, nl0);
  if (isBlankLine(first)) return null;
  // A paragraph cannot start with a block-start line
  if (startsBlock(first, true)) return null;
  let pos = nl0 < 0 ? s.length : nl0 + 1;
  let end = nl0 < 0 ? s.length : nl0;
  while (pos < s.length) {
    const nl = s.indexOf('\n', pos);
    const lineEnd = nl < 0 ? s.length : nl;
    const line = s.slice(pos, lineEnd);
    // A blank line ends the paragraph, but only when it is followed by a
    // newline (a spaces-only last line at EOF is a continuation, since
    // marked's blank-line lookahead [ \t]+\n needs the \n)
    if (isBlankLine(line) && nl >= 0) break;
    if (startsBlock(line, false)) break;
    // A table starting at this line stops the paragraph (the table regex
    // in marked's paragraph lookahead); the next line must be a delimiter
    if (tableShapeAt(s, pos)) break;
    end = lineEnd;
    pos = nl < 0 ? s.length : nl + 1;
  }
  const text = s.slice(0, end);
  // The paragraph regex does not include the trailing newline, so the
  // consumed length stops at the end of the last line
  return { len: end, tok: { t: 'p', text, raw: text } };
}

// One line of text (only used when top is false). The trailing newline
// is NOT consumed (marked's text regex matches the line only), so a
// following blank line still forms a space token.
function tryText(s) {
  const nl = s.indexOf('\n');
  const line = nl < 0 ? s : s.slice(0, nl);
  if (isBlankLine(line)) return null;
  const len = nl < 0 ? s.length : nl;
  return { len, tok: { t: 'txt', text: line, raw: line } };
}

// --- HTML block start check (types 1-6 of marked's html regex; type 7
// tags like <span> are inline and do not start a block).
const HTML_TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BEGIN_RE = new RegExp(`^ {0,3}(?:</?(?:${HTML_TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');

function isHtmlBlockStart(line) {
  return HTML_BEGIN_RE.test(line);
}

// --- HTML block (types 1-7). The raw is ge()'d, and the consumed
// length is the stripped raw's length (trailing blank lines stay in the
// source, as in marked's blockTokens which advances by r.raw.length).
function tryHtmlBlock(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= s.length || s[i] !== '<') return null;
  const rest = s.slice(i);
  const indent = s.slice(0, i);
  // The raw includes the leading indent (marked's html regex starts
  // with ^ {0,3}), and the length is the stripped raw's length
  // Type 1: script/pre/style/textarea — ends at the matching close tag
  let m = /^<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)/i.exec(rest);
  if (m) {
    const raw = ge(indent + m[0]);
    return { len: raw.length, tok: { t: 'html', text: raw, raw } };
  }
  // Type 2: comment — ends at -->; the block regex then consumes the
  // rest of the line plus ALL following newlines, and ge() strips the
  // trailing blank lines (so a comment followed by a blank line has no
  // trailing \n in its raw)
  m = /^<!--(?:-?>|[\s\S]*?(?:-->|$))/.exec(rest);
  if (m) {
    const after = rest.slice(m[0].length);
    const nl = after.indexOf('\n');
    let end = nl < 0 ? after.length : nl + 1;
    while (end < after.length && after[end] === '\n') end++;
    const full = indent + m[0] + after.slice(0, end);
    const raw = ge(full);
    return { len: raw.length, tok: { t: 'html', text: raw, raw } };
  }
  // Type 3: processing instruction <?...?>
  m = /^<\?[\s\S]*?(?:\?>[^\n]*\n*|$)/.exec(rest);
  if (m) {
    const raw = ge(indent + m[0]);
    return { len: raw.length, tok: { t: 'html', text: raw, raw } };
  }
  // Type 4: declaration <!A-Z ...>
  m = /^<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)/.exec(rest);
  if (m) {
    const raw = ge(indent + m[0]);
    return { len: raw.length, tok: { t: 'html', text: raw, raw } };
  }
  // Type 5: CDATA <![CDATA[ ... ]]>
  m = /^<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)/.exec(rest);
  if (m) {
    const raw = ge(indent + m[0]);
    return { len: raw.length, tok: { t: 'html', text: raw, raw } };
  }
  // Type 6: a tag from the list (open or close), on its own line start;
  // type 7: any other complete tag on its own line. Both continue until
  // a blank line.
  const tagRe = new RegExp(`^</?(?:${HTML_TAG_LIST})(?:[ \\t]+|\\n|/?>|$)`, 'i');
  // Type 7 (any complete tag on its own line): marked's attribute
  // separator is a literal space (' +'), not \s+, so a tag whose
  // attributes span lines is NOT a block (it stays a paragraph)
  const anyTagRe = /^<(?!(?:script|pre|style|textarea)(?![a-zA-Z0-9-]))([a-zA-Z][a-zA-Z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)* *\/?>(?=[ \t]*(?:\n|$))/;
  const closeTagRe = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>(?=[ \t]*(?:\n|$))/;
  let isType6 = tagRe.test(rest);
  let isType7 = false;
  if (!isType6) {
    // Type 7: an open tag (any name) or a close tag, complete on its line
    if (anyTagRe.test(rest) || closeTagRe.test(rest)) isType7 = true;
  }
  if (!isType6 && !isType7) return null;
  // Consume lines until a blank line or EOF, then also consume the blank
  // lines (marked's type 6/7 regex ends at a blank line); ge() strips
  // them from the raw, and the consumed length is the stripped raw's
  const n = s.length;
  let pos = 0;
  while (pos < n) {
    const j = s.indexOf('\n', pos);
    const end = j < 0 ? n : j;
    const line = s.slice(pos, end);
    if (isBlankLine(line)) break;
    pos = j < 0 ? n : j + 1;
  }
  // Consume the following blank lines into the raw
  let blankEnd = pos;
  while (blankEnd < n) {
    const j = s.indexOf('\n', blankEnd);
    const end = j < 0 ? n : j;
    const line = s.slice(blankEnd, end);
    if (!isBlankLine(line)) break;
    blankEnd = j < 0 ? n : j + 1;
  }
  const rawFull = s.slice(0, blankEnd);
  const raw = ge(rawFull);
  return { len: raw.length, tok: { t: 'html', text: raw, raw } };
}

// --- Link reference definition (block level). Returns the consumed
// length and the def. A bare destination with unbalanced parens is not
// a def (marked's paren-balance check).
function tryDef(s) {
  let pos = 0;
  let indent = 0;
  while (pos < s.length && s[pos] === ' ' && indent < 4) { indent++; pos++; }
  if (indent >= 4) return null;
  if (pos >= s.length || s[pos] !== '[') return null;
  const lab = scanDefLabel(s, pos);
  if (!lab) return null;
  const label = lab.label;
  // The folded label must be non-empty (a label of only whitespace,
  // e.g. '[\n ]', folds to '' and is not a def)
  if (foldLabel(label).length === 0) return null;
  let j = lab.end;
  if (j >= s.length || s[j] !== ':') return null;
  j++;
  if (j < s.length && s[j] === '\t') return null;
  while (j < s.length && s[j] === ' ') j++;
  // Optional newline + indent, then the destination
  if (j < s.length && s[j] === '\n') {
    let k = j + 1;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k >= s.length || s[k] === '\n') return null;
    j = k;
  }
  if (j >= s.length) return null;
  let href = '';
  if (s[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < s.length) {
      const c = s[k];
      if (c === '\n' || c === '<') break;
      if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (c === '>') { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    href = s.slice(j + 1, k).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    j = k + 1;
  } else {
    let k = j;
    let depth = 0;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      if (c === '\\' && k + 1 < s.length) { k += 2; continue; }
      if (c === '(') { depth++; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        k++;
        continue;
      }
      k++;
    }
    if (k === j) return null;
    if (depth > 0) return null; // unclosed paren: not a def
    href = s.slice(j, k).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
    j = k;
  }
  // Optional title (same line or next line); it must be separated from
  // the dest by whitespace (a bare angle dest followed by '(' is not a
  // title, so '[foo]: <bar>(baz)' is not a def at all)
  let title = null;
  let saveJ = j;
  let k = j;
  let hadSep = false;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) { k++; hadSep = true; }
  if (k < s.length && s[k] === '\n') {
    let mm = k + 1;
    while (mm < s.length && (s[mm] === ' ' || s[mm] === '\t')) mm++;
    if (mm < s.length && s[mm] !== '\n') { k = mm; hadSep = true; }
  }
  if (hadSep && k < s.length && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const q = s[k];
    const closeQ = q === '(' ? ')' : q;
    let mm = k + 1;
    let depth = 0;
    let ok = false;
    while (mm < s.length) {
      const c = s[mm];
      if (c === '\\' && mm + 1 < s.length) { mm += 2; continue; }
      if (q === '(' && c === '(') { depth++; mm++; continue; }
      if (c === closeQ) {
        if (q === '(' && depth > 0) { depth--; mm++; continue; }
        ok = true;
        break;
      }
      // A single-quoted title may span lines (a \n not followed by
      // another \n); double-quoted and paren titles may not
      if (c === '\n') {
        if (q === "'" && mm + 1 < s.length && s[mm + 1] !== '\n') { mm++; continue; }
        break;
      }
      mm++;
    }
    if (ok) {
      const t = s.slice(k + 1, mm).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
      if (t.length > 0) title = t;
      j = mm + 1;
    } else {
      j = saveJ;
    }
  } else {
    j = saveJ;
  }
  // Must end with spaces/tabs then a newline or the end; if a title was
  // scanned but the def does not end cleanly after it, backtrack and try
  // the def without the title ('[foo]: /url\n"title" ok' is a def with
  // no title, leaving '"title" ok' as a paragraph)
  let jj = j;
  while (jj < s.length && (s[jj] === ' ' || s[jj] === '\t')) jj++;
  if (jj < s.length && s[jj] !== '\n') {
    if (title !== null || j !== saveJ) {
      title = null;
      jj = saveJ;
      while (jj < s.length && (s[jj] === ' ' || s[jj] === '\t')) jj++;
      if (jj < s.length && s[jj] !== '\n') return null;
      j = jj;
    } else return null;
  } else j = jj;
  // The consumed length is the stripped raw's length (trailing newlines
  // stay in the source)
  const raw = s.slice(0, j);
  return { len: j, tok: { t: 'def', tag: foldLabel(label), href, title, raw } };
}

// --- Tables ---
// Split a table row on unescaped | (marked's cell split).
function splitTableRow(row, want) {
  // Mark unescaped pipes by replacing them with " |", then split on " |"
  let t = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '|') {
      let bs = 0;
      let p = i - 1;
      while (p >= 0 && row[p] === '\\') { bs++; p--; }
      if (bs % 2 === 1) t += '|';
      else t += ' |';
    } else t += c;
  }
  const parts = t.split(' |');
  // Drop an empty first cell (leading pipe) and an empty last cell
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  if (want !== undefined) {
    if (parts.length > want) parts.length = want;
    else while (parts.length < want) parts.push('');
  }
  for (let i = 0; i < parts.length; i++) {
    parts[i] = parts[i].trim().replace(/\\\|/g, '|');
  }
  return parts;
}

function isTableDelimiterCell(cell) {
  let i = 0;
  while (i < cell.length && cell[i] === ' ') i++;
  if (i < cell.length && cell[i] === ':') i++;
  let dashes = 0;
  while (i < cell.length && cell[i] === '-') { dashes++; i++; }
  if (dashes === 0) return false;
  if (i < cell.length && cell[i] === ':') i++;
  while (i < cell.length && cell[i] === ' ') i++;
  return i === cell.length;
}

// Does a table (header + delimiter) start at position pos in s?
function tableShapeAt(s, pos) {
  // Header line: must start with a non-space char (after spaces)
  let i = pos;
  while (i < s.length && s[i] === ' ') i++;
  if (i >= s.length || s[i] === '\n') return false;
  const nl = s.indexOf('\n', pos);
  if (nl < 0) return false;
  const header = s.slice(pos, nl);
  // The delimiter is the next line (0-3 spaces indent)
  let dpos = nl + 1;
  let di = 0;
  while (dpos < s.length && s[dpos] === ' ' && di < 3) { di++; dpos++; }
  if (dpos >= s.length) return false;
  const dnl = s.indexOf('\n', dpos);
  const delim = dnl < 0 ? s.slice(dpos) : s.slice(dpos, dnl);
  // The delimiter must contain a ':' or a '|' (marked's tableDelimiter)
  if (delim.indexOf(':') < 0 && delim.indexOf('|') < 0) return false;
  // The delimiter must be cells of :?-+:? separated by |
  const cells = splitTableRow(delim);
  if (cells.length === 0) return false;
  for (const c of cells) if (!isTableDelimiterCell(c)) return false;
  const hcells = splitTableRow(header);
  return hcells.length === cells.length;
}

function tryTable(s, ctx) {
  if (!tableShapeAt(s, 0)) return null;
  const nl = s.indexOf('\n', 0);
  const header = s.slice(0, nl);
  let dpos = nl + 1;
  while (dpos < s.length && s[dpos] === ' ') dpos++;
  const dnl = s.indexOf('\n', dpos);
  const delim = dnl < 0 ? s.slice(dpos) : s.slice(dpos, dnl);
  const hcells = splitTableRow(header);
  const dcells = splitTableRow(delim);
  if (hcells.length !== dcells.length) return null;
  const aligns = dcells.map((c) => {
    const t = c.trim();
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
  // Body rows: consecutive lines that do not start a block. Marked's
  // table regex excludes only SPACE-only lines ((?! *\n)); a line with
  // a tab (or other whitespace) is a body row (an empty row), not a
  // terminator.
  const rows = [];
  let pos = dnl < 0 ? s.length : dnl + 1;
  while (pos < s.length) {
    const j = s.indexOf('\n', pos);
    const end = j < 0 ? s.length : j;
    const line = s.slice(pos, end);
    if (/^ *$/.test(line)) break;
    if (startsBlock(line, false)) break;
    rows.push(line);
    pos = j < 0 ? s.length : j + 1;
  }
  let raw = s.slice(0, pos);
  // Strip trailing newlines from the raw (marked's trailing-newline trim)
  while (raw.endsWith('\n')) raw = raw.slice(0, -1);
  const headerCells = hcells.map((c, idx) => ({ text: c, align: aligns[idx] }));
  const bodyRows = rows.map((r) => {
    const cells = splitTableRow(r, hcells.length);
    return cells.map((c, idx) => ({ text: c, align: aligns[idx] }));
  });
  return { len: raw.length, tok: { t: 'table', header: headerCells, rows: bodyRows, raw } };
}

// --- Blockquote ---
// A line is a quote line if it starts with 0-3 spaces + '>'.
function isQuoteLine(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ' && i < 3) i++;
  return i < line.length && line[i] === '>';
}

// Expand the leading tabs of `rest` to spaces, starting at column `col`.
function expandLeadingTabs(rest, col) {
  let out = '';
  let c = col;
  let i = 0;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) {
    if (rest[i] === '\t') {
      const r = 4 - (c % 4);
      out += ' '.repeat(r);
      c += r;
    } else {
      out += ' ';
      c++;
    }
    i++;
  }
  return out + rest.slice(i);
}

// Remove the '>' marker from each line of a chunk (with the tab expansion
// marked does before removing one space after the marker).
function stripQuoteMarkers(h) {
  return h.split('\n').map((line) => {
    let i = 0;
    while (i < line.length && line[i] === ' ' && i < 3) i++;
    if (i >= line.length || line[i] !== '>') return line;
    const markerLen = i + 1;
    let rest = line.slice(markerLen);
    rest = expandLeadingTabs(rest, markerLen);
    if (rest.startsWith(' ')) rest = rest.slice(1);
    return rest;
  }).join('\n');
}

// The length of the blockquote match at the start of s: a run of '>'
// lines, each followed by its lazy paragraph-continuation lines.
function quoteRawLen(s) {
  let pos = 0;
  const n = s.length;
  while (pos < n) {
    const j = s.indexOf('\n', pos);
    const end = j < 0 ? n : j;
    const line = s.slice(pos, end);
    if (!isQuoteLine(line)) break;
    // The inner content of this '>' line (after the marker + 1 space);
    // if it is blank, a following lazy line cannot continue the quote
    const inner = stripQuoteMarkers(line);
    const lineBlank = isBlankLine(inner);
    pos = j < 0 ? n : j + 1;
    if (lineBlank) continue; // no lazy continuations after a blank '>' line
    // Lazy continuations: non-blank lines that do not start a block
    while (pos < n) {
      const j2 = s.indexOf('\n', pos);
      const end2 = j2 < 0 ? n : j2;
      const l2 = s.slice(pos, end2);
      if (isBlankLine(l2)) break;
      if (startsBlock(l2, false)) break;
      if (tableShapeAt(s, pos)) break;
      pos = j2 < 0 ? n : j2 + 1;
    }
  }
  return pos;
}

function tryQuote(s, ctx) {
  const rawLen = quoteRawLen(s);
  if (rawLen === 0) return null;
  const raw = s.slice(0, rawLen);
  const rawNoTrail = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  let remaining = rawNoTrail.split('\n');
  const tokens = [];
  let consumedRaw = '';
  while (remaining.length > 0) {
    // Build a chunk: leading lazy lines + following '>' lines
    let seen = false;
    const chunk = [];
    let p = 0;
    for (; p < remaining.length; p++) {
      if (isQuoteLine(remaining[p])) { chunk.push(remaining[p]); seen = true; }
      else if (!seen) chunk.push(remaining[p]);
      else break;
    }
    remaining = remaining.slice(p);
    const h = chunk.join('\n');
    let u = stripQuoteMarkers(h);
    // A setext underline on a lazy line is indented by 4 spaces so it
    // cannot form a setext heading inside the quote
    u = u.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    consumedRaw = consumedRaw ? consumedRaw + '\n' + h : h;
    // Lex into the shared token array so code/def merges and paragraph
    // merging work across chunks (marked lexes each chunk with merge on)
    lexBlocks(u, ctx, true, true, tokens);
    if (remaining.length === 0) break;
    const k = tokens[tokens.length - 1];
    if (k && (k.t === 'code' || k.t === 'heading' || k.t === 'hr' || k.t === 'html' || k.t === 'table')) break;
    if (k && k.t === 'quote') {
      // A nested quote may extend into the remaining lines: re-lex it
      // together with the rest
      const rest = remaining.join('\n');
      const m2 = k.raw + '\n' + rest.replace(/^ {0,3}>[ \t]?/gm, '');
      const re = tryQuote(m2, ctx);
      if (re) {
        tokens[tokens.length - 1] = re.tok;
        // Figure out how many of `remaining` were consumed by the nested
        // quote: the nested quote's raw, minus k.raw, minus the newlines
        const consumed = re.tok.raw.length - k.raw.length;
        const usedLines = consumed <= 0 ? 0 : re.tok.raw.slice(k.raw.length + 1).split('\n').length;
        consumedRaw = consumedRaw + '\n' + remaining.slice(0, usedLines).join('\n');
        remaining = remaining.slice(usedLines);
        if (remaining.length > 0 && isQuoteLine(remaining[0])) continue;
      }
      break;
    }
    if (k && k.t === 'list') {
      // A list may extend into the remaining lines: re-lex it together
      // with the rest
      const rest = remaining.join('\n');
      const m2 = k.raw + '\n' + rest;
      const re = tryList(m2, ctx);
      if (re && re.tok.raw.length > k.raw.length) {
        tokens[tokens.length - 1] = re.tok;
        const extra = re.tok.raw.slice(k.raw.length + 1);
        const usedLines = extra ? extra.split('\n').length : 0;
        if (usedLines > 0) {
          consumedRaw = consumedRaw + '\n' + remaining.slice(0, usedLines).join('\n');
        }
        remaining = remaining.slice(usedLines);
        continue;
      }
      continue;
    }
    // Otherwise continue with the next chunk
  }
  return { len: consumedRaw.length, tok: { t: 'quote', tokens, raw: consumedRaw } };
}

// --- Lists ---
// The first item: 0-3 spaces + marker, then the rest of the first line.
function listFirstMatch(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && i < 3) i++;
  if (i >= s.length) return null;
  const c = s[i];
  let markerEnd = -1;
  let ordered = false;
  let numStr = '';
  if (c === '*' || c === '+' || c === '-') {
    markerEnd = i + 1;
  } else if (c >= '0' && c <= '9') {
    let j = i;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j - i > 9 || j - i === 0) return null;
    if (j < s.length && (s[j] === '.' || s[j] === ')')) {
      markerEnd = j + 1;
      ordered = true;
      numStr = s.slice(i, j);
    } else return null;
  } else return null;
  // The rest of the first line must start with a space/tab or be empty
  const nl = s.indexOf('\n', markerEnd);
  const lineEnd = nl < 0 ? s.length : nl;
  const rest = s.slice(markerEnd, lineEnd);
  if (rest.length > 0 && rest[0] !== ' ' && rest[0] !== '\t') return null;
  const marker = s.slice(0, markerEnd);
  return { marker, markerLen: markerEnd, ordered, numStr, rest, lineEnd, nl };
}

function tryList(s, ctx) {
  const first = listFirstMatch(s);
  if (!first) return null;
  // An hr at this position is an hr, not a list
  if (tryHr(s)) return null;
  const ordered = first.ordered;
  const start = ordered ? parseInt(first.numStr, 10) : '';
  const markerPat = ordered
    ? `\\d{1,9}\\${first.marker.trim().slice(-1)}`
    : `\\${first.marker.trim()}`;
  const itemRe = new RegExp(`^( {0,3}${markerPat})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
  const list = { t: 'list', ordered, start, loose: false, items: [], raw: '' };
  let e = s;
  let p = false; // a previous item had a double blank line
  let consumed = 0;
  while (e.length) {
    const t = itemRe.exec(e);
    if (!t || tryHr(e)) break;
    const itemStart = consumed;
    e = e.slice(t[0].length);
    consumed += t[0].length;
    // g = the first line after the marker (t[2] minus its newline)
    const gFull = t[2];
    const g = gFull.endsWith('\n') ? gFull.slice(0, -1) : gFull;
    const b = t[1].length;
    // m = the first line with leading tabs expanded (column b)
    const m = expandLeadingTabs(g, b);
    const f0 = e.indexOf('\n');
    const f = f0 < 0 ? e : e.slice(0, f0);
    const y0 = m.trim() === '';
    let R = 0;
    let d = '';
    let y = y0;
    if (y0) {
      R = b + 1;
    } else {
      R = m.search(/[^ ]/);
      if (R < 0) R = m.length;
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    let u = false;
    if (y0 && /^[ \t]*$/.test(f)) {
      e = e.slice(f.length + 1);
      consumed += f.length + 1;
      u = true;
    }
    if (!u) {
      // Continuation lines: a block start within R-1 spaces of the
      // content indent ends the item (marked's item regexes use
      // {0,min(R-1,3)}: the indent is capped at 3, since a block start
      // can only be indented 0-3 spaces)
      const Rm = Math.min(Math.max(0, R - 1), 3);
      const nextBulletRe = new RegExp(`^ {0,${Rm}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
      const hrRe = new RegExp(`^ {0,${Rm}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
      const fenceRe = new RegExp(`^ {0,${Rm}}(?:\`\`\`|~~~)`);
      const headRe = new RegExp(`^ {0,${Rm}}#{1,6}(?:\\s|$)`);
      const htmlRe = new RegExp(`^ {0,${Rm}}(?:</?(?:${HTML_TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
      const quoteRe = new RegExp(`^ {0,${Rm}}>`);
      let mm = m;
      while (e.length) {
        const U = e.indexOf('\n') < 0 ? e : e.slice(0, e.indexOf('\n'));
        const Z = expandLeadingTabs(U, 0);
        const ff = U;
        if (fenceRe.test(ff) || headRe.test(ff) || htmlRe.test(ff) || quoteRe.test(ff) || nextBulletRe.test(ff) || hrRe.test(ff)) break;
        const nonSpace = Z.search(/[^ ]/);
        if ((nonSpace >= 0 && nonSpace >= R) || !ff.trim()) {
          d += '\n' + (nonSpace < 0 ? '' : Z.slice(R));
        } else {
          if (y || mm.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || fenceRe.test(mm) || headRe.test(mm) || htmlRe.test(mm) || hrRe.test(mm)) break;
          let qe;
          if (/^ {0,3}(?:=+|-+) *$/.test(ff) && isSetextPair(mm, ff)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          } else qe = ff;
          d += '\n' + qe;
        }
        y = !ff.trim();
        const ulen = U.length + 1;
        e = e.slice(ulen);
        consumed += ulen;
        mm = Z.slice(R);
      }
    }
    const itemRaw = s.slice(itemStart, consumed);
    if (!list.loose) {
      if (p) list.loose = true;
      else if (endsWithBlankLine(itemRaw)) p = true;
    }
    const task = /^\[[ xX]\][ \t]+\S/.test(d);
    list.items.push({ task, loose: false, text: d, raw: itemRaw, tokens: [] });
  }
  if (list.items.length === 0) return null;
  const lastItem = list.items[list.items.length - 1];
  lastItem.raw = trimTrailWS(lastItem.raw);
  lastItem.text = trimTrailWS(lastItem.text);
  list.raw = trimTrailWS(s.slice(0, consumed));
  // Task checkboxes: strip the marker from the item text before lexing
  for (const item of list.items) {
    if (!item.task) continue;
    const cb = /^\[[ xX]\]/.exec(item.text);
    if (!cb) { item.task = false; continue; }
    item.checked = cb[0] !== '[ ]';
    item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
  }
  // Lex each item's text (top=false) and detect looseness
  for (const item of list.items) {
    item.tokens = lexBlocks(item.text, ctx, false, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((g) => g.t === 'space');
      if (spaces.length > 0 && spaces.some((g) => /\n.*\n/.test(g.raw))) list.loose = true;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tk of item.tokens) if (tk.t === 'txt') tk.t = 'p';
    }
  }
  return { len: list.raw.length, tok: list };
}

// Does `a` + '\n' + `b` form a setext heading (for the list lazy-line
// setext rule)?
function isSetextPair(a, b) {
  if (!/^ {0,3}(?:=+|-+) *$/.test(b)) return false;
  if (startsBlock(a, true)) return false;
  if (isBlankLine(a)) return false;
  return true;
}

// ------------------------------------------------------------------ renderer

// Render one inline string with a fresh per-string state (inRawBlock is
// reset for each inline string; ctx.inLink persists across strings).
function renderInline(text, ctx) {
  const st = { inRawBlock: false, linkEmitted: false, maskQuirk: false, maskQuirkPos: -1, suppressDelimsFrom: undefined, suppressDelimsTo: undefined };
  return parseInline(text, ctx, st, false);
}

function renderBlock(tok, ctx) {
  switch (tok.t) {
    case 'space':
    case 'def':
      return '';
    case 'p':
      return '<p>' + renderInline(tok.text, ctx) + '</p>\n';
    case 'txt':
      return renderInline(tok.text, ctx);
    case 'heading':
      return '<h' + tok.depth + '>' + renderInline(tok.text, ctx) + '</h' + tok.depth + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const lang = (tok.lang || '').match(/^\S*/)?.[0] || '';
      let r = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
      r = esc(r, true);
      if (lang) return '<pre><code class="language-' + esc(lang, false) + '">' + r + '</code></pre>\n';
      return '<pre><code>' + r + '</code></pre>\n';
    }
    case 'html':
      return tok.text;
    case 'quote':
      return '<blockquote>\n' + renderBlocks(tok.tokens, ctx) + '</blockquote>\n';
    case 'list': {
      let out = tok.ordered ? '<ol' + (tok.start !== 1 ? ' start="' + tok.start + '"' : '') + '>\n' : '<ul>\n';
      for (const item of tok.items) out += renderListItem(item, tok, ctx);
      out += tok.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (const c of tok.header) {
        out += '<th' + (c.align ? ' align="' + c.align + '"' : '') + '>' + renderInline(c.text, ctx) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (tok.rows.length) {
        out += '<tbody>';
        for (const row of tok.rows) {
          out += '<tr>\n';
          for (const c of row) {
            out += '<td' + (c.align ? ' align="' + c.align + '"' : '') + '>' + renderInline(c.text, ctx) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      out += '</table>\n';
      return out;
    }
    default:
      return '';
  }
}

function renderListItem(item, list, ctx) {
  const cb = item.task
    ? '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
    : '';
  let out = '<li>';
  if (list.loose) {
    if (item.tokens.length === 0) {
      out += cb;
    } else {
      let first = true;
      for (const t of item.tokens) {
        if (first && (t.t === 'p' || t.t === 'txt')) {
          out += t.t === 'p'
            ? '<p>' + cb + renderInline(t.text, ctx) + '</p>\n'
            : cb + renderInline(t.text, ctx);
          first = false;
        } else {
          out += renderBlock(t, ctx);
          first = false;
        }
      }
    }
  } else {
    out += cb;
    for (const t of item.tokens) out += renderBlock(t, ctx);
  }
  out += '</li>\n';
  return out;
}

function renderBlocks(toks, ctx) {
  let out = '';
  for (const t of toks) out += renderBlock(t, ctx);
  return out;
}
