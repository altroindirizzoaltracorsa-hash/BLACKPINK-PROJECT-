// feedback → Supabase + Discord webhook notification, and the reply path back.
//
//   POST /api/feedback { message, category, contact, username, replyVia, accessToken }
//        → { ok, ticket? }. `replyVia` is 'site' | 'email' | 'handle' | 'none'
//          and says where the sender wants an answer. `ticket` comes back only
//          for an on-site reply with no account behind it — it is the only way
//          that row can ever be read again, so it is shown to them once.
//   GET  /api/feedback?mine=1            → my own messages + replies (Bearer)
//   GET  /api/feedback?ticket=CODE       → one message + its reply, by claim code
//   GET  /api/feedback?admin=1&key=…     → the queue, newest first
//   POST /api/feedback { action:'reply', id, reply, key }      → write a reply
//   POST /api/feedback { action:'mark-sent', id, key }         → mark it sent by hand
//
// WHY THE SENDER PICKS THE CHANNEL. The form has always offered "email or
// @handle (optional — for a reply)" and there was no reply path at all, so the
// promise was empty. Rather than guess a single channel, the sender says which
// one they want: a signed-in blink usually wants it on the site, someone who
// left an email wants an email, and plenty of people want no reply and should
// not sit in the queue looking ignored.
//
// NOTHING IS SENT FROM HERE for the email/handle routes: no mail service is
// configured on this project. Those replies are composed in the admin view and
// sent by hand, which `reply_sent_at` records — deliberately separate from
// `replied_at`, which only means the text has been written.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET, DISCORD_WEBHOOK_URL.
// Schema: supabase/feedback.sql
import { createClient } from '@supabase/supabase-js';

function supabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Same gate as every other admin endpoint here (see isAdmin in api/leaderboard.js).
function isAdmin(req) {
  const adminSecret = process.env.ADMIN_SECRET;
  const key = req.query.key || (req.body || {}).key;
  return !!adminSecret && key === adminSecret;
}

const REPLY_VIA = ['site', 'email', 'handle', 'none'];

// A claim code someone has to be able to read back off a screen and type again
// later, so the alphabet drops the characters that get confused for each other
// (O/0, I/l/1). 8 of these is ~40 bits — not a secret worth attacking, but far
// past guessing a stranger's feedback by hand.
const TICKET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newTicket() {
  const bytes = new Uint8Array(8);
  // globalThis.crypto, not node:crypto: this file is an ES module, so a
  // require() fallback would throw if it were ever reached. Web Crypto is on
  // globalThis in every runtime this deploys to (Node 18+).
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => TICKET_ALPHABET[b % TICKET_ALPHABET.length]).join('');
}

// What the sender is allowed to see of their own row. Never the admin key, and
// never another row — the caller is identified by their account or their ticket.
const MINE_COLS = 'id, created_at, message, category, reply_via, reply, replied_at';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = supabase();
  if (!sb) return res.status(503).json({ error: 'Feedback service not configured' });

  try {
    if (req.method === 'GET') {
      // ── the sender's own view ──────────────────────────────────────────────
      if (req.query.mine) {
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
        if (!m) return res.status(401).json({ error: 'not signed in' });
        const { data: { user } = {}, error: authErr } = await sb.auth.getUser(m[1]);
        if (authErr || !user) return res.status(401).json({ error: 'not signed in' });
        const { data, error } = await sb.from('feedback')
          .select(MINE_COLS).eq('app_user_id', user.id)
          .order('created_at', { ascending: false }).limit(50);
        if (error) throw error;
        return res.status(200).json({ messages: data || [] });
      }

      // ── the sender's own view, without an account ─────────────────────────
      if (req.query.ticket) {
        const ticket = String(req.query.ticket).trim().toUpperCase().slice(0, 16);
        // A short code is the whole credential here, so don't let it be probed
        // in bulk: one row, exact match, and the same answer either way.
        if (!/^[A-Z0-9]{6,16}$/.test(ticket)) return res.status(404).json({ error: 'not found' });
        const { data, error } = await sb.from('feedback')
          .select(MINE_COLS).eq('ticket', ticket).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'not found' });
        return res.status(200).json({ messages: [data] });
      }

      // ── the queue ─────────────────────────────────────────────────────────
      if (req.query.admin) {
        if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        let q = sb.from('feedback')
          .select('id, created_at, message, category, contact, username, app_user_id, reply_via, ticket, reply, replied_at, reply_sent_at')
          .order('created_at', { ascending: false }).limit(limit);
        // The default view is the work: everything still waiting on you. A row
        // whose sender asked for no reply is not waiting on anything.
        //
        // The `or` is load-bearing, not defensive. `reply_via` is null on every
        // row written before the form asked — 66 of them when this shipped —
        // and `neq('reply_via','none')` drops those, because SQL compares null
        // to anything as null, not as true. The whole existing backlog would
        // have been invisible behind a filter that looked like it was working.
        // Null means "we never asked", which is not the same as "they said no".
        if (req.query.open) q = q.is('reply', null).or('reply_via.is.null,reply_via.neq.none');
        const { data, error } = await q;
        if (error) throw error;
        return res.status(200).json({ messages: data || [] });
      }

      return res.status(400).json({ error: 'nothing to get' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};

    // ── writing a reply ──────────────────────────────────────────────────────
    if (body.action === 'reply' || body.action === 'mark-sent') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
      if (body.id == null || body.id === '') return res.status(400).json({ error: 'id required' });
      // `id` is passed through exactly as given: this table was created by hand
      // and its id is a bigint on the live database but a uuid on a fresh one
      // (see supabase/feedback.sql), so the API must not assume either.
      const patch = body.action === 'mark-sent'
        ? { reply_sent_at: new Date().toISOString() }
        : (() => {
            const text = String(body.reply || '').trim();
            if (!text) return null;
            return { reply: text.slice(0, 4000), replied_at: new Date().toISOString() };
          })();
      if (!patch) return res.status(400).json({ error: 'reply required' });
      const { data, error } = await sb.from('feedback')
        .update(patch).eq('id', body.id).select('id, reply, replied_at, reply_sent_at').maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ ok: true, message: data });
    }

    // ── a new piece of feedback ──────────────────────────────────────────────
    const { message, category, contact, username } = body;
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });

    const replyVia = REPLY_VIA.includes(body.replyVia) ? body.replyVia : null;

    // Attach the account when they are signed in. Best-effort on purpose:
    // feedback has never needed an account and must not start failing without
    // one, so a bad or expired token just means the row is anonymous.
    let appUserId = null;
    const accessToken = String(body.accessToken || '').trim();
    if (accessToken) {
      try {
        const { data: { user } = {} } = await sb.auth.getUser(accessToken);
        appUserId = user?.id || null;
      } catch (_) { appUserId = null; }
    }

    // A ticket is only for the case that actually needs one: they want the reply
    // on the site and there is no account to hang it on.
    const ticket = (replyVia === 'site' && !appUserId) ? newTicket() : null;

    const row = {
      message: message.trim().slice(0, 2000),
      category: category || 'general',
      contact: contact?.trim().slice(0, 100) || null,
      username: username?.trim().slice(0, 100) || null,
    };
    if (replyVia) row.reply_via = replyVia;
    if (appUserId) row.app_user_id = appUserId;
    if (ticket) row.ticket = ticket;

    const { error } = await sb.from('feedback').insert(row);
    if (error) return res.status(500).json({ error: error.message });

    // Discord notification (best-effort, don't fail the request if it errors).
    if (process.env.DISCORD_WEBHOOK_URL) {
      const categoryEmoji = { bug: '🐛', suggestion: '💡', feature: '💡', praise: '💗', general: '💬' };
      const emoji = categoryEmoji[category] || '💬';
      const lines = [
        `${emoji} **New feedback** · \`${category || 'general'}\``,
        `>>> ${message.trim().slice(0, 1800)}`,
      ];
      if (username) lines.push(`**Last.fm:** ${username}`);
      if (contact)  lines.push(`**Contact:** ${contact}`);
      // Say how they asked to be answered, so the ping is enough to act on.
      const how = {
        site:   appUserId ? 'on the site (signed in — reply from /feedback)' : `on the site (code \`${ticket}\`)`,
        email:  'by email',
        handle: 'on their handle',
        none:   'no reply wanted',
      }[replyVia];
      if (how) lines.push(`**Reply:** ${how}`);
      try {
        await fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: lines.join('\n') }),
        });
      } catch (_) {}
    }

    // The ticket goes back exactly once, at submit time. It is not derivable
    // from anything, and nothing else will ever hand it over, so the page has
    // to put it in front of them properly.
    return res.status(201).json({ ok: true, ticket: ticket || undefined, signedIn: !!appUserId });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'error' });
  }
}
