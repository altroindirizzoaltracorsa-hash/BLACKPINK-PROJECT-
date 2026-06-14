// feedback → Supabase + Discord webhook notification
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, category, contact, username } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'Feedback service not configured' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { error } = await sb.from('feedback').insert({
    message: message.trim().slice(0, 2000),
    category: category || 'general',
    contact: contact?.trim().slice(0, 100) || null,
    username: username?.trim().slice(0, 100) || null,
  });

  if (error) return res.status(500).json({ error: error.message });

  // Discord notification (best-effort, don't fail the request if it errors)
  if (process.env.DISCORD_WEBHOOK_URL) {
    const categoryEmoji = { bug: '🐛', suggestion: '💡', praise: '💗', general: '💬' };
    const emoji = categoryEmoji[category] || '💬';
    const lines = [
      `${emoji} **New feedback** · \`${category || 'general'}\``,
      `>>> ${message.trim().slice(0, 1800)}`,
    ];
    if (username) lines.push(`**Last.fm:** ${username}`);
    if (contact)  lines.push(`**Contact:** ${contact}`);
    fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    }).catch(() => {});
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ ok: true });
}
