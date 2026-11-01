// PostgreSQL SQL compatibility helpers. Keep this module driver-free so it can be tested
// before the async pg runtime is enabled.
export function postgresPlaceholders(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
  let out = '', index = 0, state = 'normal', dollarTag = '', blockDepth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (state === 'single' || state === 'escape-single') {
      out += ch;
      if (ch === "'" && next === "'") { out += next; i++; }
      else if (ch === "'") state = 'normal';
      else if (state === 'escape-single' && ch === '\\' && next) { out += next; i++; }
      continue;
    }
    if (state === 'double') {
      out += ch;
      if (ch === '"' && next === '"') { out += next; i++; }
      else if (ch === '"') state = 'normal';
      continue;
    }
    if (state === 'line-comment') {
      out += ch;
      if (ch === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      out += ch;
      if (ch === '/' && next === '*') { out += next; i++; blockDepth++; }
      else if (ch === '*' && next === '/') {
        out += next; i++;
        if (--blockDepth === 0) state = 'normal';
      }
      continue;
    }
    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, i)) { out += dollarTag; i += dollarTag.length - 1; state = 'normal'; }
      else out += ch;
      continue;
    }
    if (ch === "'") {
      const previous = sql[i - 1], beforePrevious = sql[i - 2];
      const isEscapeString = (previous === 'E' || previous === 'e') && (!beforePrevious || !/[A-Za-z0-9_$]/.test(beforePrevious));
      state = isEscapeString ? 'escape-single' : 'single';
      out += ch;
      continue;
    }
    if (ch === '"') { state = 'double'; out += ch; continue; }
    if (ch === '-' && next === '-') { state = 'line-comment'; out += '--'; i++; continue; }
    if (ch === '/' && next === '*') { state = 'block-comment'; blockDepth = 1; out += '/*'; i++; continue; }
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; state = 'dollar'; out += dollarTag; i += dollarTag.length - 1; continue; }
    }
    if (ch === '?') { out += '$' + (++index); continue; }
    out += ch;
  }
  if (state === 'single' || state === 'escape-single' || state === 'double' || state === 'block-comment' || state === 'dollar') {
    throw new SyntaxError('Unterminated SQL literal or comment');
  }
  return { text: out, count: index };
}

export function normalizePostgresResult(result) {
  return {
    changes: result.rowCount ?? 0,
    rows: result.rows ?? [],
    lastInsertRowid: result.rows?.[0]?.id ?? null
  };
}
