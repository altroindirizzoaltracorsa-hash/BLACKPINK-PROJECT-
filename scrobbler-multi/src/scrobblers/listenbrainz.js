/*
 * ListenBrainz client — token based, no request signing.
 * Each account is just a user token from https://listenbrainz.org/settings/
 */

const API_ROOT = 'https://api.listenbrainz.org';

async function submit(token, payload) {
  const res = await fetch(`${API_ROOT}/1/submit-listens`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

function metadata(track) {
  const meta = {
    artist_name: track.artist,
    track_name: track.title,
    additional_info: { submission_client: 'sessionbox-multi-scrobbler' },
  };
  if (track.album) meta.release_name = track.album;
  if (track.duration) meta.additional_info.duration_ms = Math.round(track.duration * 1000);
  return meta;
}

export async function validateToken(token) {
  const res = await fetch(`${API_ROOT}/1/validate-token`, {
    headers: { 'Authorization': `Token ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return { valid: !!data.valid, user: data.user_name };
}

export async function updateNowPlaying(token, track) {
  return submit(token, {
    listen_type: 'playing_now',
    payload: [{ track_metadata: metadata(track) }],
  });
}

export async function scrobble(token, track, timestamp) {
  return submit(token, {
    listen_type: 'single',
    payload: [{ listened_at: timestamp, track_metadata: metadata(track) }],
  });
}
