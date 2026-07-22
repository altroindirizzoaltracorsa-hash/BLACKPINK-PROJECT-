/**
 * One-off diagnostic: looks up a linked_accounts row by source+username and,
 * if found, fetches the owning auth.users record (email, created/last-sign-in)
 * via the Supabase Auth Admin API so we can tell whether a "username already
 * linked" conflict is a live account or an abandoned/orphaned one.
 *
 * Usage: LOOKUP_SOURCE=lastfm LOOKUP_USERNAME=pink node check-linked-account.mjs
 * Safe to remove once it's been run.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const SOURCE        = process.env.LOOKUP_SOURCE || 'lastfm';
const USERNAME      = process.env.LOOKUP_USERNAME;

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); process.exit(1); }
  if (!USERNAME) { console.error('LOOKUP_USERNAME not set'); process.exit(1); }

  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/linked_accounts?select=*&source=eq.${encodeURIComponent(SOURCE)}&source_username=ilike.${encodeURIComponent(USERNAME)}`,
    { headers },
  );
  if (!r.ok) { console.error(`linked_accounts query failed: HTTP ${r.status} ${await r.text()}`); process.exit(1); }
  const rows = await r.json();

  if (!rows.length) {
    console.log(`No linked_accounts row found for source="${SOURCE}" username="${USERNAME}" (case-insensitive).`);
    console.log('The unique-constraint error must be coming from a row with different-but-equivalent casing, or the row was removed since the user hit the error.');
    return;
  }

  for (const row of rows) {
    console.log(`--- linked_accounts row ---`);
    console.log(JSON.stringify(row, null, 2));

    const ur = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${row.app_user_id}`, { headers });
    if (!ur.ok) {
      console.log(`  Could not fetch owning user: HTTP ${ur.status} ${await ur.text()}`);
      continue;
    }
    const user = await ur.json();
    console.log(`--- owning auth user ---`);
    console.log(JSON.stringify({
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at,
      confirmed_at: user.confirmed_at,
      banned_until: user.banned_until,
    }, null, 2));

    const lr = await fetch(`${SUPABASE_URL}/rest/v1/linked_accounts?select=source,source_username&app_user_id=eq.${row.app_user_id}`, { headers });
    if (lr.ok) {
      const otherLinks = await lr.json();
      console.log(`  All accounts linked to this same profile: ${JSON.stringify(otherLinks)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
