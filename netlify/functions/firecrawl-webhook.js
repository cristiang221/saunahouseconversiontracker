const { getAdminClient } = require('./_supabaseAdmin');

// Receives Firecrawl monitor webhooks and stores results in
// market_intel_checks for the app's "Market Intel" tab. See
// https://docs.firecrawl.dev/features/monitoring for Firecrawl's own event
// docs (monitor.page fires per-page-check; monitor.check.completed fires
// once the whole check finishes).
//
// One endpoint serves every monitor (competitor pricing, reviews, content
// research) — each monitor is configured with a webhookUrl that includes
// ?category=...&label=... query params, so there's no need for a separate
// mapping table to know which monitor a given payload came from.
//
// No signature verification here — Firecrawl's public docs don't describe
// webhook signing as of this writing, so this endpoint only ever INSERTs
// (never updates/deletes anything) to limit the blast radius if the URL
// ever leaks. If that turns out to matter, rotate it by redeploying with a
// new random path segment and updating the monitors' webhookUrl.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const params = new URLSearchParams(event.queryStringParameters || {});
  const category = params.get('category') || 'content';
  const label = params.get('label') || 'Unknown source';

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  const admin = getAdminClient();
  const rows = [];
  const type = payload.type;
  const dataItems = Array.isArray(payload.data) ? payload.data : (payload.data ? [payload.data] : []);

  if (type === 'monitor.page') {
    // Skip 'same' (unchanged) checks entirely — logging every unchanged
    // cycle would just be noise on a tab meant to surface real changes.
    for (const item of dataItems) {
      if (item.status === 'same') continue;
      rows.push({
        category,
        label,
        monitor_id: item.monitorId || null,
        check_id: item.checkId || null,
        event_type: type,
        status: item.status || null,
        is_meaningful: item.isMeaningful ?? (item.judgment && item.judgment.meaningful) ?? null,
        summary: (item.judgment && item.judgment.reason) || (item.status ? `${item.url || label}: ${item.status}` : null),
        diff_text: (item.diff && item.diff.text) || null,
        raw: item,
      });
    }
  } else if (type === 'monitor.check.completed') {
    for (const item of dataItems) {
      const s = item.summary || {};
      const changedTotal = (s.changed || 0) + (s.new || 0) + (s.removed || 0);
      rows.push({
        category,
        label,
        monitor_id: item.monitorId || null,
        check_id: item.checkId || null,
        event_type: type,
        status: item.status || null,
        is_meaningful: changedTotal > 0,
        summary: `Check complete: ${s.same || 0} unchanged, ${s.changed || 0} changed, ${s.new || 0} new, ${s.removed || 0} removed, ${s.error || 0} errors.`,
        diff_text: null,
        raw: item,
      });
    }
  } else {
    // Unrecognized shape — most likely a query/search-based monitor (used
    // for the recurring content research pulls), whose exact payload isn't
    // publicly documented as of this writing. Store the raw payload so
    // nothing is lost; tighten this branch once a real example has landed
    // here and the shape is known.
    rows.push({
      category,
      label,
      monitor_id: payload.monitorId || null,
      check_id: payload.checkId || null,
      event_type: type || 'unknown',
      status: null,
      is_meaningful: null,
      summary: null,
      diff_text: null,
      raw: payload,
    });
  }

  if (rows.length) {
    const { error } = await admin.from('market_intel_checks').insert(rows);
    if (error) {
      return { statusCode: 500, body: `DB insert failed: ${error.message}` };
    }
  }

  return { statusCode: 200, body: `Stored ${rows.length} row(s).` };
};
