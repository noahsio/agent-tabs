// Minimal JSONC support: a textual "set this path" edit that leaves comments and other keys untouched.

function skipTrivia(text, index) {
  let i = index;
  for (;;) {
    if (/\s/.test(text[i] ?? "")) i++;
    else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      i = end + 2;
    } else return i;
  }
}

function endOfString(text, index) {
  let i = index + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  if (i >= text.length) throw new Error("unterminated string");
  return i + 1;
}

function endOfValue(text, index) {
  const first = text[index];
  if (first === '"') return endOfString(text, index);
  if (first === "{" || first === "[") {
    let i = index;
    let depth = 0;
    for (;;) {
      i = skipTrivia(text, i);
      if (i >= text.length) throw new Error("unterminated value");
      const char = text[i];
      if (char === '"') i = endOfString(text, i);
      else {
        if (char === "{" || char === "[") depth++;
        if (char === "}" || char === "]") depth--;
        i++;
        if (depth === 0) return i;
      }
    }
  }
  let i = index;
  while (i < text.length && !/[\s,}\]/]/.test(text[i])) i++;
  return i;
}

/** Members of the object starting at `objStart` ('{'): [{key, valueStart, valueEnd}], plus whether any exist. */
function members(text, objStart) {
  const found = [];
  let i = objStart + 1;
  for (;;) {
    i = skipTrivia(text, i);
    if (text[i] === "}") return found;
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] !== '"') throw new Error("unexpected token in object");
    const keyEnd = endOfString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd));
    i = skipTrivia(text, keyEnd);
    if (text[i] !== ":") throw new Error("expected ':'");
    const valueStart = skipTrivia(text, i + 1);
    const valueEnd = endOfValue(text, valueStart);
    found.push({ key, valueStart, valueEnd });
    i = valueEnd;
  }
}

function nested(pathRest, value) {
  return pathRest.reduceRight((inner, key) => ({ [key]: inner }), value);
}

function setAt(text, objStart, pathKeys, value) {
  const [key, ...rest] = pathKeys;
  const all = members(text, objStart);
  const member = all.find((candidate) => candidate.key === key);
  if (!member) {
    const insertion = ` ${JSON.stringify(key)}: ${JSON.stringify(nested(rest, value))}${all.length ? "," : ""}`;
    return text.slice(0, objStart + 1) + insertion + text.slice(objStart + 1);
  }
  if (rest.length === 0) {
    return text.slice(0, member.valueStart) + JSON.stringify(value) + text.slice(member.valueEnd);
  }
  if (text[member.valueStart] !== "{") throw new Error(`"${key}" is not an object`);
  return setAt(text, member.valueStart, rest, value);
}

/** Parse JSONC (comments, trailing commas) into a value. */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith("//", i) || text.startsWith("/*", i)) i = skipTrivia(text, i);
    else out += text[i++];
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Set `value` at `pathKeys` in JSONC `text`, preserving everything else byte for byte.
 * Throws when the structure is unexpected, so the caller can fall back to a note.
 */
export function setJsoncPath(text, pathKeys, value) {
  const rootStart = skipTrivia(text, 0);
  if (text[rootStart] !== "{") throw new Error("root is not an object");
  const edited = setAt(text, rootStart, pathKeys, value);
  let probe = parseJsonc(edited);
  for (const key of pathKeys) probe = probe?.[key];
  if (JSON.stringify(probe) !== JSON.stringify(value)) throw new Error("edit did not produce the expected value");
  return edited;
}
