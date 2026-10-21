// Every table a migration creates has to say who may reach it.
//
// Run: node .github/scripts/test_sql_grants.mjs
//
// Supabase stops auto-granting Data API access to new tables in `public` on
// 2026-10-30. Existing tables keep the grants they already have, so production
// is not affected — but from that date a table needs an explicit GRANT before
// supabase-js, PostgREST or the service-role key can touch it, and that applies
// to any table created from then on AND to every recreation of this schema: a
// new project, a preview branch, a local `supabase db reset`.
//
// The failure is a "permission denied" at runtime, in a route that worked for
// months, long after whoever wrote the migration moved on. So the decision is
// forced here instead, in the file that creates the table, where a reader can
// see it: either the file grants something on that table, or it says in words
// that nothing should be granted and why.
//
// The opt-out line, for a table nothing outside Postgres may reach:
//
//     -- no grants on <table>: <reason>
//
// Which is a real case, not an escape hatch — fan_name_counters is reached only
// by security-definer functions, and granting anybody access to it would let a
// signed-in person mint display names at will.
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../', import.meta.url).pathname;
const dir = root + 'supabase/';
let fails = [];
const check = (c, m, d) => { console.log((c ? '  ok   ' : '  FAIL ') + m + (d ? ` (${d})` : '')); if (!c) fails.push(m); };

// WHICH role a table needs is not a matter of taste — it follows from who
// actually queries it. Asking only "is there any grant at all" let a table keep
// its `authenticated` line while losing the `service_role` one it is read with,
// which is the exact shape of the production break. So the requirement is
// derived from the code: `.from('<table>')` under api/ runs with the
// service-role key, and the same call in a page at the repo root runs in a
// browser with the anon key.
function usedBy(dirOrFiles, isDir) {
  const out = new Map();
  const files = isDir
    ? readdirSync(root + dirOrFiles).filter((f) => f.endsWith('.js')).map((f) => dirOrFiles + '/' + f)
    : dirOrFiles;
  for (const f of files) {
    let src;
    try { src = readFileSync(root + f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/\.from\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1]).add(f);
    }
  }
  return out;
}
const serverUse  = usedBy('api', true);
const browserUse = usedBy(readdirSync(root).filter((f) => f.endsWith('.html')), false);
check(serverUse.size > 5, 'the scan sees which tables the server queries', `${serverUse.size}`);
check(browserUse.size > 0, 'and which the browser queries', [...browserUse.keys()].join(', '));

// Both places migrations live. supabase/migrations/ was missed on the first
// pass and is exactly where the next gap was: kca_user_votes, the Kids' Choice
// vote board, is created there with only a function grant. supabase/checks and
// supabase/tests create nothing that ships — the test file's own stub tables
// are not this project's schema.
const files = [
  ...readdirSync(dir).filter((f) => f.endsWith('.sql')),
  ...readdirSync(dir + 'migrations').filter((f) => f.endsWith('.sql')).map((f) => 'migrations/' + f),
].sort();
check(files.length > 0, 'there are migrations to check', `${files.length} files`);

const ROLES = ['anon', 'authenticated', 'service_role'];
let tables = 0, granted = 0, waived = 0;

for (const f of files) {
  const src = readFileSync(dir + f, 'utf8');
  // Comments are stripped before looking for CREATE TABLE, so prose about
  // creating tables (feedback.sql discusses `create table if not exists`)
  // cannot invent one.
  const code = src.replace(/^\s*--.*$/gm, '');
  const names = [...code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?("?[a-z_][a-z0-9_]*"?)/gi)]
    .map((m) => m[1].replace(/"/g, ''));
  for (const t of new Set(names)) {
    tables++;
    // A grant naming this table, or one of the blanket "all tables in schema
    // public" forms. Looked for in the code, not the comments.
    const grantedTo = (role) =>
      new RegExp(`grant\\s+[^;]*?\\son\\s+(?:table\\s+)?(?:public\\.)?"?${t}"?\\s+to\\s+[^;]*\\b${role}\\b`, 'is').test(code)
      || new RegExp(`grant\\s+[^;]*?\\son\\s+all\\s+tables\\s+in\\s+schema\\s+public\\s+to\\s+[^;]*\\b${role}\\b`, 'is').test(code);
    const any = ROLES.some(grantedTo);
    // The waiver has to name the table, so it cannot be a vague note at the
    // top of a file that creates four of them.
    const waiver = new RegExp(`--\\s*no grants on\\s+(?:public\\.)?${t}\\s*:\\s*\\S`, 'i').test(src);

    // Required, from usage rather than from preference.
    const byServer = serverUse.get(t);
    const byBrowser = browserUse.get(t);
    if (byServer) {
      check(grantedTo('service_role'), `${f}: ${t} is queried by the server, and grants service_role`,
            grantedTo('service_role')
              ? [...byServer].map((x) => x.replace('api/', '')).join(', ')
              : `read in ${[...byServer].join(', ')} — the service role bypasses RLS but NOT grants`);
      check(!waiver, `${f}: ${t} is in use, so it is not waived`,
            waiver ? 'the waiver says nothing may reach it, and the server does' : '');
    }
    if (byBrowser) {
      check(grantedTo('authenticated') || grantedTo('anon'),
            `${f}: ${t} is queried by the browser, and grants it access`,
            grantedTo('authenticated') || grantedTo('anon') ? [...byBrowser].join(', ')
              : `read in ${[...byBrowser].join(', ')} with the anon key`);
    }
    if (byServer || byBrowser) { granted++; continue; }

    // Nothing queries it through the Data API. Then the file has to say whether
    // that is the intent — a table reached only by a security-definer function
    // is a real case, a table somebody forgot is not, and they look identical.
    if (any) {
      granted++;
      check(!waiver, `${f}: ${t} is granted, and not also waived`,
            waiver ? 'it says both — one of them is wrong' : '');
    } else if (waiver) {
      waived++;
      check(true, `${f}: ${t} deliberately reaches nobody, and says why`);
    } else {
      check(false, `${f}: ${t} has no grant and no reason`,
            'after 2026-10-30 a recreate of this table answers "permission denied"');
    }
  }
}

console.log(`\n  ${tables} tables — ${granted} granted, ${waived} deliberately not`);
check(tables > 10, 'the scan found the schema, not a corner of it', `${tables} tables`);

// The one table the BROWSER reaches directly (everything else goes through
// /api/* with the service key, or an rpc with its own execute grant). Its
// grant is the one whose absence would be most visible and least obvious: the
// RLS policies would still be there, correct, and matching nothing.
const li = readFileSync(dir + 'linked_accounts.sql', 'utf8');
check(/grant[^;]*on\s+(?:table\s+)?(?:public\.)?linked_accounts\s+to\s+authenticated/is.test(li),
      'linked_accounts, the one table the browser touches, grants authenticated');

console.log(`\nFAILURES: ${fails.length}`);
fails.forEach((f) => console.log('  - ' + f));
process.exit(fails.length ? 1 : 0);
