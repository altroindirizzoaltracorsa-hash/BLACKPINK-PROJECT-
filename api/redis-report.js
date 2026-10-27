// /api/redis-report — what is actually in Redis, and how big is it.
//
//   GET /api/redis-report            (x-admin-secret / ?key=)  → plain-text table
//   GET /api/redis-report?json=1                               → the same as JSON
//   GET /api/redis-report?gzip=1                               → also measure compression
//
// WHY THIS EXISTS. Upstash bills bandwidth, and its console reports one number
// for the whole database. When that number ran out on 2026-10-24 there was no
// way to ask which keys it had gone to — Redis keeps no per-caller accounting,
// so the only honest answers came from reading the code and measuring endpoints
// one at a time. This closes half that gap: bandwidth is SIZE x HOW OFTEN, and
// this measures the size half directly, per key family, from the live database.
// The other half (how often) is what the callers column is for.
//
// IT DOES NOT READ VALUES. Sizes come from STRLEN / LLEN / HLEN / SCARD, which
// return integers, and list byte-sizes are estimated from ONE sampled element.
// A diagnostic that pulled every value to measure it would be a meaningful part
// of the bill it is trying to explain — which is exactly the mistake that made
// this necessary.
//
// Env: UPSTASH_REDIS_REST_URL / _TOKEN (or the _B pair), ADMIN_SECRET.

import { gzipSync } from 'zlib';

// SECOND DATABASE (optional) — see the note in api/streams.js. Reads
// UPSTASH_REDIS_REST_URL_B/_TOKEN_B when both are set, otherwise the primary.
const storeUrl = () => process.env.UPSTASH_REDIS_REST_URL_B || process.env.UPSTASH_REDIS_REST_URL;
const storeToken = () => process.env.UPSTASH_REDIS_REST_TOKEN_B || process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstash(cmds) {
  const r = await fetch(`${storeUrl()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${storeToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// SCAN, never KEYS. KEYS blocks the server and returns every name at once; on a
// database whose size is the open question that is the wrong first move.
async function scanAll(limit = 5000) {
  const keys = [];
  let cursor = '0';
  do {
    const [res] = await upstash([['SCAN', cursor, 'COUNT', '500']]);
    const [next, batch] = res?.result || ['0', []];
    cursor = next;
    keys.push(...(batch || []));
  } while (cursor !== '0' && keys.length < limit);
  return keys;
}

// Group keys into families WITHOUT guessing what an identifier looks like.
//
// The first version split on "_" and collapsed the last segment if it looked
// id-ish. YouTube ids contain underscores (h-7_04c_hVc), so those keys each
// became their own family and the very data this is meant to size scattered
// into singletons. Instead: for each key take the LONGEST prefix (ending at a
// "_" or ":") that at least one other key also has. Unique keys like
// bu_leaderboard_v1 keep their full name; bp_hist_jump and its three siblings
// collapse to bp_hist_*; and the YouTube keys collapse whatever their ids
// contain, because the answer comes from the data rather than from a pattern.
function groupKeys(keys) {
  const prefixesOf = k => {
    const out = [];
    for (let i = 0; i < k.length; i++) if (k[i] === '_' || k[i] === ':') out.push(k.slice(0, i + 1));
    return out;
  };
  const counts = new Map();
  for (const k of keys) for (const p of new Set(prefixesOf(k))) counts.set(p, (counts.get(p) || 0) + 1);
  // At least two separators, so a bare namespace is not a family: "bu_" is
  // shared by nearly everything, and taking it would file bu_leaderboard_v1 and
  // bu_ingest_debug together under bu_* — which is how the second version of
  // this collapsed two unrelated singletons into one row.
  const seps = p => (p.match(/[_:]/g) || []).length;
  const familyOf = {};
  for (const k of keys) {
    const shared = prefixesOf(k).filter(p => counts.get(p) > 1 && seps(p) >= 2);
    familyOf[k] = shared.length ? shared[shared.length - 1] + '*' : k;
  }
  return familyOf;
}

const human = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB`
  : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;

export default async function handler(req, res) {
  const secret = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-secret'] || req.query.key;
  if (!secret || given !== secret) return res.status(401).json({ error: 'unauthorized' });
  if (!storeUrl() || !storeToken()) {
    return res.status(503).json({ error: 'store_unavailable', detail: 'UPSTASH_REDIS_REST_URL / _TOKEN are not set' });
  }

  try {
    const keys = await scanAll();

    // One pipeline for the types, then one for the sizes. Both return integers
    // and short type names — the whole scan costs a few KB however big the
    // values are.
    const types = (await upstash(keys.map(k => ['TYPE', k]))).map(r => r?.result);
    const sizeCmd = (k, t) => t === 'string' ? ['STRLEN', k]
      : t === 'list' ? ['LLEN', k]
      : t === 'hash' ? ['HLEN', k]
      : t === 'set' ? ['SCARD', k]
      : t === 'zset' ? ['ZCARD', k] : ['STRLEN', k];
    const lens = (await upstash(keys.map((k, i) => sizeCmd(k, types[i])))).map(r => Number(r?.result) || 0);

    // For containers, one sampled element gives a per-entry byte size. One
    // element, not the list — the difference between a diagnostic and a bill.
    const sampleIdx = keys.map((k, i) => [k, types[i], i]).filter(([, t]) => t === 'list' || t === 'hash');
    const samples = sampleIdx.length
      ? await upstash(sampleIdx.map(([k, t]) => t === 'list' ? ['LINDEX', k, '0'] : ['HRANDFIELD', k, '1', 'WITHVALUES']))
      : [];
    const perEntry = {};
    sampleIdx.forEach(([k], n) => {
      const v = samples[n]?.result;
      const s = Array.isArray(v) ? v.join('') : v;
      perEntry[k] = s ? String(s).length : 0;
    });

    const familyOf = groupKeys(keys);
    const rows = {};
    keys.forEach((k, i) => {
      const t = types[i];
      const bytes = (t === 'string') ? lens[i] : lens[i] * (perEntry[k] || 0);
      const f = familyOf[k];
      const row = rows[f] || (rows[f] = { family: f, type: t, keys: 0, entries: 0, bytes: 0, biggest: null, biggestBytes: 0 });
      row.keys++;
      row.entries += (t === 'string') ? 0 : lens[i];
      row.bytes += bytes;
      if (bytes > row.biggestBytes) { row.biggestBytes = bytes; row.biggest = k; }
    });

    const list = Object.values(rows).sort((a, b) => b.bytes - a.bytes);
    const total = list.reduce((s, r) => s + r.bytes, 0);

    // Compression, measured rather than assumed: gzip the single largest value
    // and report both sizes. Whether Upstash BILLS the compressed figure is
    // their answer to give, not something visible from here — but this says
    // what there is to gain if it does, and reads exactly one value to do it.
    let compression = null;
    if (req.query.gzip === '1' && list.length) {
      const target = list[0];
      if (target.type === 'string' && target.biggest) {
        const [v] = await upstash([['GET', target.biggest]]);
        const raw = String(v?.result ?? '');
        const gz = gzipSync(Buffer.from(raw)).length;
        compression = {
          key: target.biggest, raw: raw.length, gzipped: gz,
          ratio: raw.length ? +(raw.length / gz).toFixed(1) : null,
        };
      } else if (target.type === 'list' && target.biggest) {
        // A SAMPLE of the list, not the list. This used to skip anything that
        // was not a plain string, which skipped the biggest family on the
        // database — the one the question is actually about — and left the
        // answer to the only family small enough not to matter.
        //
        // The sample is what makes it safe: a bulk read is how these are
        // really fetched, so the ratio has to come from a run of entries
        // rather than from one (a single 54-byte row compresses to nothing
        // useful and would report gzip as a LOSS), but reading the whole
        // 687 KB list to measure it would put this diagnostic into the bill
        // it exists to explain. The figure is extrapolated and says so.
        const SAMPLE = 200;
        const [v] = await upstash([['LRANGE', target.biggest, String(-SAMPLE), '-1']]);
        const got = Array.isArray(v?.result) ? v.result : [];
        const raw = got.join('\n');
        const gz = gzipSync(Buffer.from(raw)).length;
        compression = {
          key: target.biggest, sampled: got.length, raw: raw.length, gzipped: gz,
          ratio: raw.length ? +(raw.length / gz).toFixed(1) : null,
        };
      } else {
        compression = { note: `largest family is a ${target.type}; not sampled` };
      }
    }

    if (req.query.json === '1') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ scannedKeys: keys.length, totalBytes: total, families: list, compression });
    }

    const lines = [];
    lines.push(`Redis contents — ${keys.length} keys, ~${human(total)} stored`);
    lines.push('');
    lines.push('  SIZE        KEYS   ENTRIES  FAMILY');
    lines.push('  ' + '-'.repeat(68));
    for (const r of list) {
      lines.push(`  ${human(r.bytes).padStart(9)}  ${String(r.keys).padStart(5)}  ${String(r.entries).padStart(8)}  ${r.family}`);
    }
    lines.push('');
    lines.push('Size is what one full read of that family costs. Bandwidth is that');
    lines.push('times how often it is read — cross-reference the callers in the repo.');
    if (compression) {
      lines.push('');
      if (compression.note) {
        lines.push(compression.note);
      } else if (compression.sampled != null) {
        // Said as a sample, with the extrapolation shown rather than folded
        // into a single number: the ratio is measured, the family total it
        // implies is arithmetic, and the two should not be read as one
        // measurement.
        const row = list[0];
        lines.push(`Compression on ${compression.key}: ${compression.sampled} entries sampled, `
          + `${human(compression.raw)} raw -> ${human(compression.gzipped)} gzipped (${compression.ratio}x)`);
        if (compression.ratio) {
          lines.push(`At that ratio the ${row.family} family's ${human(row.bytes)} would move as `
            + `~${human(Math.round(row.bytes / compression.ratio))} — IF Upstash bills compressed bytes,`);
          lines.push('which is their answer to give. This measures what there is to gain, not whether you get it.');
        }
      } else {
        lines.push(`Compression on ${compression.key}: ${human(compression.raw)} raw -> ${human(compression.gzipped)} gzipped (${compression.ratio}x)`);
      }
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(lines.join('\n'));
  } catch (e) {
    return res.status(503).json({ error: 'store_unavailable', detail: e?.message || String(e) });
  }
}
