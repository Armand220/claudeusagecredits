// A language filter for what people type into a party: names, tasks and
// messages. The word lists are base64 so the source isn't a wall of swearing.
// Matching sees through capitals, accents, l33t spelling (sh1t), stretched
// letters (fuuuck) and letters spaced out with dots or spaces (f.u.c.k),
// without catching ordinary words (class, Scunthorpe, cocktail, grape).

const list = (b64) => atob(b64).split(',');
// Bad anywhere, even inside a longer word (they don't hide in ordinary ones).
const STEMS = list('ZnVjayxzaGl0LGN1bnQsbmlnZ2VyLG5pZ2dhLGZhZ2dvdCxiaXRjaCx3aG9yZSxzbHV0LGJhc3RhcmQsYXNzaG9sZSxhcnNlaG9sZSxkaWNraGVhZCxqaXp6LGJvbGxvY2ssZG91Y2hlLGRpbGRvLGJsb3dqb2IsaGFuZGpvYixza2Fuayxwb3JuLGR1bWJhc3MsamFja2Fzcyxhc3NoYXQsYXNzd2lwZSx3ZXRiYWNrLG1vdGhlcmZ1Y2ssY29ja3N1Y2ssdHdhdCx3YW5rZXI=');
// Bad only as whole words, because they're inside ordinary ones.
const WORDS = list('YXNzLGFzc2VzLGFyc2UsYXJzZXMsZGljayxkaWNrcyxjb2NrLGNvY2tzLHRpdHMsdGl0dHksdGl0dGllcyxjdW0sY3VtbWluZyxwaXNzLHBpc3NlZCxwaXNzaW5nLHByaWNrLHByaWNrcyxyYXBlLHJhcGVkLHJhcGluZyxyYXBpc3QscmV0YXJkLHJldGFyZHMscmV0YXJkZWQsc3BpYyxzcGljcyxjaGluayxjaGlua3MsZHlrZSxkeWtlcyx0cmFubnksdHJhbm5pZXMscHVzc3kscHVzc2llcyxib29iLGJvb2JzLHd0ZixzdGZ1LG5hemksbmF6aXMsc2hhZyxzbGFnLGJ1Z2dlcixraWtlLGtpa2VzLGNvb24sY29vbnMsZmFnLGZhZ3Msd2Fuayx3YW5raW5nLGdvb2ssZ29va3MscGFraSxwYWtpcyxzcGF6LGhvZSxob2VzLGN1bXNob3Q=');
// Ordinary words that look like a bad one (Scunthorpe, a town in England, is
// the classic example of a filter wrongly starring out an innocent word).
const ALLOW = new Set(list('c2hpaXRha2Usc2N1bnRob3JwZSxuaWdnYXJkLG5pZ2dhcmRseSxjb2NrYnVybixwZW5pc3RvbmUsaGFuY29jayxwZWFjb2NrLGNvY2t0YWlsLGFzc2Vzcyxhc3Nlc3Nlcw=='));

const LEET = { 4: 'a', '@': 'a', 3: 'e', 1: 'i', '!': 'i', '|': 'i', 0: 'o', 5: 's', $: 's', 7: 't', '+': 't', 8: 'b', 9: 'g' };
const isWordChar = (c) => /[a-z0-9]/.test(c);

// Each letter may repeat, with dots, dashes or underscores between them.
const spell = (w) => [...w].map((c) => `${c}+`).join('[._~-]*');
const STEM_RE = new RegExp(`(?:${STEMS.map(spell).join('|')})`, 'g');
const WORD_RE = new RegExp(`(^|[^a-z0-9])(${WORDS.map(spell).join('|')})(?![a-z0-9])`, 'g');
// Three or more single letters with a space or mark between each: "f u c k".
const SPACED_RE = /(^|[^a-z0-9])((?:[a-z][^a-z0-9\n]{1,3}){2,}[a-z])(?![a-z0-9])/g;
const BAD_STEM = new RegExp(`(?:${STEMS.join('|')})`);
const BAD_WORD = new RegExp(`^(?:${WORDS.join('|')})$`);

// One plain lower-case letter per character, so positions line up with the original.
function plain(chars) {
  return chars.map((c) => {
    const base = c.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()[0] || c;
    return LEET[base] || base;
  });
}

/** Ranges [start, end) of bad language, in code points of `text`. */
function find(text) {
  const chars = [...String(text)];
  const norm = plain(chars);
  const s = norm.join('');
  // The regexes work in UTF-16 units; map those back to code points.
  const at = [];
  norm.forEach((c, i) => {
    for (let k = 0; k < c.length; k++) at.push(i);
  });
  at.push(chars.length);
  const hits = [];
  const add = (from, to) => hits.push([at[from], at[to]]);

  for (const m of s.matchAll(STEM_RE)) {
    // The whole word it sits in, to let ordinary words through.
    let a = m.index;
    let b = m.index + m[0].length;
    while (a > 0 && /[a-z]/.test(s[a - 1])) a--;
    while (b < s.length && /[a-z]/.test(s[b])) b++;
    if (!ALLOW.has(s.slice(a, b))) add(m.index, m.index + m[0].length);
  }
  for (const m of s.matchAll(WORD_RE)) if (!ALLOW.has(m[2])) add(m.index + m[1].length, m.index + m[0].length);
  for (const m of s.matchAll(SPACED_RE)) {
    const letters = m[2].replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1$1');
    const squeezed = letters.replace(/(.)\1+/g, '$1');
    if (BAD_STEM.test(letters) || BAD_STEM.test(squeezed) || BAD_WORD.test(letters) || BAD_WORD.test(squeezed)) add(m.index + m[1].length, m.index + m[0].length);
  }
  return hits;
}

/** True when the text has bad language in it. */
export const isRude = (text) => find(text).length > 0;

/** The text with any bad language starred out (letters only, so it still reads as words). */
export function clean(text) {
  const hits = find(text);
  if (!hits.length) return String(text);
  const chars = [...String(text)];
  for (const [a, b] of hits) {
    for (let i = a; i < b; i++) if (!/\s/.test(chars[i])) chars[i] = '*';
  }
  return chars.join('');
}
