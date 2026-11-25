// HTML's named entities for Latin-1, in code point order from U+00A0, so French, Spanish and
// German text decodes. Postal-mime has a full table but does not export it.
const LATIN_1 = `
  nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn
  sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave
  Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml
  ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN
  szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave
  iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute
  ucirc uuml yacute thorn yuml`
  .trim()
  .split(/\s+/);
const ENTITIES = new Map<string, string>([
  ...LATIN_1.map((name, index): [string, string] => [name, String.fromCodePoint(0xa0 + index)]),
  // A plain space in the chat, as mail apps pad with no-break ones.
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["OElig", "Œ"],
  ["oelig", "œ"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["sbquo", "‚"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bdquo", "„"],
  ["hellip", "…"],
  ["bull", "•"],
  ["euro", "€"],
  ["trade", "™"],
]);

const decodeEntity = (whole: string, name: string) => {
  if (!name.startsWith("#")) return ENTITIES.get(name) ?? whole;
  const code = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
  // A lone surrogate is not text that Postgres or JSON can keep.
  const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return valid ? String.fromCodePoint(code) : whole;
};

/** Decodes numeric entities, decimal or hex, and the named ones in the table. Anything else stays. */
export const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,7});/gi, decodeEntity);
