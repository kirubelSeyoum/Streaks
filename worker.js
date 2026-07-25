// Streaks reminder backend — deploy this as a Cloudflare Worker (free plan).
//
// What it does:
//  1. POST /sync  — your app calls this whenever a habit or its reminder changes.
//     Body: { topic, timezone, habits: [{ id, name, reminderOn, reminderHour, reminderMinute, doneToday }] }
//     Stores this in Workers KV. Requires an Authorization: Bearer <SYNC_SECRET> header.
//  2. scheduled() — runs every minute (Cron Trigger you set up in the dashboard).
//     Compares the current local time (in your stored timezone) against each habit's
//     reminder time, and if it matches and the habit isn't done yet today and hasn't
//     already fired today, pushes a notification to your ntfy.sh topic.
//
// Setup requires (all via the Cloudflare dashboard, no CLI needed):
//  - A KV namespace bound to this Worker as REMINDERS_KV
//  - A secret named SYNC_SECRET (Settings → Variables and Secrets)
//  - A Cron Trigger set to "* * * * *" (Settings → Triggers)

const STATE_KEY = 'state';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function isAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.SYNC_SECRET}`;
}

function getLocalParts(timezone) {
  const now = new Date();
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch (e) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }
  const parts = {};
  fmt.formatToParts(now).forEach(p => { parts[p.type] = p.value; });
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}

async function handleSync(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('Invalid JSON', { status: 400, headers: corsHeaders() });
  }
  if (!body || !body.topic || !Array.isArray(body.habits)) {
    return new Response('Missing topic or habits', { status: 400, headers: corsHeaders() });
  }

  // Preserve lastFiredDate per habit across syncs so we don't double-fire.
  const existingRaw = await env.REMINDERS_KV.get(STATE_KEY);
  const existing = existingRaw ? JSON.parse(existingRaw) : { habits: [] };
  const existingById = {};
  (existing.habits || []).forEach(h => { existingById[h.id] = h; });

  const habits = body.habits.map(h => ({
    id: h.id,
    name: h.name,
    reminderOn: !!h.reminderOn,
    reminderHour: h.reminderHour,
    reminderMinute: h.reminderMinute,
    doneToday: !!h.doneToday,
    lastFiredDate: existingById[h.id] ? existingById[h.id].lastFiredDate : null,
    lastError: existingById[h.id] ? existingById[h.id].lastError : null,
  }));

  const state = {
    topic: body.topic,
    timezone: body.timezone || 'UTC',
    habits,
    updatedAt: Date.now(),
  };
  await env.REMINDERS_KV.put(STATE_KEY, JSON.stringify(state));
  return new Response(JSON.stringify({ ok: true, habitCount: habits.length }), {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

async function handleStatus(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders() });
  }
  const raw = await env.REMINDERS_KV.get(STATE_KEY);
  return new Response(raw || '{}', {
    status: 200,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    if (url.pathname === '/sync' && request.method === 'POST') {
      return handleSync(request, env);
    }
    if (url.pathname === '/status' && request.method === 'GET') {
      return handleStatus(request, env);
    }
    return new Response('Streaks reminder backend is running.', { status: 200, headers: corsHeaders() });
  },

  async scheduled(event, env, ctx) {
    const raw = await env.REMINDERS_KV.get(STATE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state.topic || !Array.isArray(state.habits)) return;

    const { dateStr, hour, minute } = getLocalParts(state.timezone);
    let changed = false;

    for (const h of state.habits) {
      if (!h.reminderOn || h.doneToday) continue;
      if (h.lastFiredDate === dateStr) continue;
      if (h.reminderHour !== hour || h.reminderMinute !== minute) continue;

      try {
        const resp = await fetch(`https://ntfy.sh/${encodeURIComponent(state.topic)}`, {
          method: 'POST',
          headers: {
            'Title': 'Streaks',
            'Priority': 'default',
            'Tags': 'repeat',
          },
          body: `Time for: ${h.name}`,
        });
        if (resp.ok) {
          h.lastFiredDate = dateStr;
          h.lastError = null;
        } else {
          const bodyText = await resp.text().catch(() => '');
          h.lastError = `ntfy responded ${resp.status}: ${bodyText.slice(0, 200)}`;
        }
      } catch (e) {
        h.lastError = `fetch to ntfy failed: ${e.message}`;
      }
      changed = true;
    }

    if (changed) {
      await env.REMINDERS_KV.put(STATE_KEY, JSON.stringify(state));
    }
  },
};
