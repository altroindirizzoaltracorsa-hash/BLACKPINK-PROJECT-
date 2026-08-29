/*
 * Read-only: resolve the token/linking picture.
 *   1. scrobble_tokens  → which profiles (app_user_id + label) have a token the
 *      extension can use, and how many.
 *   2. linked_accounts  → rows referencing the target user (by source_username)
 *      and rows for the app_user_ids currently receiving extension plays.
 *   3. For each app_user_id seen scrobbling in the last 48h, print its token label
 *      + its linked_accounts handles, so we can see who "owns" the shared buckets
 *      and whether the target user is one of them.
 */
const URL  = process.env.SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_KEY;
const USER = process.env.USERNAME || '_demibandwout';
if (!URL || !KEY) { console.error('Missing SUPABASE_*'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sb = (p) => fetch(`${URL}/rest/v1/${p}`, { headers: H }).then(async r => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));

(async () => {
  console.log(`Linking diagnostic — target user "${USER}"\n`);

  // 1. scrobble_tokens
  const tok = await sb('scrobble_tokens?select=app_user_id,label,created_at&order=created_at.asc&limit=200');
  console.log('── 1. scrobble_tokens (profiles that can scrobble via the extension) ──');
  const labelOf = {};
  if (!tok.ok) console.log(`  query failed ${tok.status}: ${JSON.stringify(tok.body).slice(0,200)}`);
  else {
    console.log(`  ${tok.body.length} token(s):`);
    for (const t of tok.body) { labelOf[t.app_user_id] = t.label; console.log(`    ${t.app_user_id}  "${t.label}"  (${(t.created_at||'').slice(0,10)})`); }
  }

  // 2. linked_accounts referencing the target username
  console.log(`\n── 2. linked_accounts where source_username ~ "${USER}" ──`);
  const la = await sb(`linked_accounts?select=app_user_id,source,source_username&source_username=ilike.*${encodeURIComponent(USER)}*&limit=50`);
  if (!la.ok) console.log(`  query failed ${la.status}: ${JSON.stringify(la.body).slice(0,200)}`);
  else if (!la.body.length) console.log('  NONE — this username is not linked to any profile.');
  else for (const r of la.body) console.log(`    app_user_id=${r.app_user_id}  source=${r.source}  source_username="${r.source_username}"`);

  // also: any linked_accounts with a spotify/extension source at all?
  console.log('\n── 2b. distinct linked_accounts.source values ──');
  const src = await sb('linked_accounts?select=source&limit=1000');
  if (src.ok && Array.isArray(src.body)) {
    const c = {}; for (const r of src.body) c[r.source] = (c[r.source]||0)+1;
    for (const [s,n] of Object.entries(c)) console.log(`    ${s}: ${n}`);
  }

  // 3. app_user_ids receiving extension plays in last 48h → who are they?
  console.log('\n── 3. app_user_ids receiving extension plays (last 48h) ──');
  const since = new Date(Date.now() - 48*3600000).toISOString();
  const rec = await fetch(`${URL}/rest/v1/extension_scrobbles?select=app_user_id&listened_at=gte.${since}`, { headers: { ...H, Range: '0-9999' } }).then(r => r.json()).catch(() => []);
  const uids = [...new Set((rec||[]).map(r => r.app_user_id))];
  for (const uid of uids) {
    const links = await sb(`linked_accounts?select=source,source_username&app_user_id=eq.${uid}&limit=50`);
    const handles = links.ok && Array.isArray(links.body) ? links.body.map(r => `${r.source}:${r.source_username}`).join(', ') : '(query failed)';
    console.log(`    ${uid}`);
    console.log(`        token label   : ${labelOf[uid] ?? '(no scrobble_token!)'}`);
    console.log(`        linked handles: ${handles || '(none)'}`);
  }
})();
