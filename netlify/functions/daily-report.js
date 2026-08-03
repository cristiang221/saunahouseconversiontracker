const { getAdminClient } = require('./_supabaseAdmin');

// This function is scheduled to run hourly (see netlify.toml) and no-ops
// unless it's currently 8pm in REPORT_TIMEZONE. Running hourly and checking
// the local hour, rather than trying to pick one fixed UTC cron time, is
// what keeps the send time correct across DST changes automatically.
const REPORT_TIMEZONE = 'America/New_York';
const REPORT_HOUR = 20;

function todayInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function currentHourInTimezone(timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(new Date()));
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendEmail({ to, from, subject, html, text }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY is not configured on the server.');
  if (!from) throw new Error('SENDGRID_FROM_EMAIL is not configured on the server.');

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: 'Sauna House Conversion Tracker' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid error ${res.status}: ${body}`);
  }
}

exports.handler = async function () {
  const hour = currentHourInTimezone(REPORT_TIMEZONE);
  if (hour !== REPORT_HOUR) {
    return { statusCode: 200, body: `Skipped — local hour is ${hour}, not ${REPORT_HOUR}.` };
  }

  const admin = getAdminClient();
  const today = todayInTimezone(REPORT_TIMEZONE);

  const [{ data: staff }, { data: entries }, { data: scheduleRows }] = await Promise.all([
    admin.from('profiles').select('id, name'),
    admin.from('entries').select('staff_id, visits, sold, revenue').eq('date', today),
    admin.from('schedule').select('staff_id').eq('date', today),
  ]);

  const staffById = Object.fromEntries((staff || []).map(s => [s.id, s]));
  const byStaff = {};
  (entries || []).forEach(e => {
    const b = (byStaff[e.staff_id] = byStaff[e.staff_id] || { visits: 0, sold: 0, revenue: 0 });
    b.visits += e.visits;
    b.sold += e.sold;
    b.revenue += Number(e.revenue) || 0;
  });

  const loggedStaffIds = new Set(Object.keys(byStaff));
  const scheduledStaffIds = new Set((scheduleRows || []).map(r => r.staff_id));
  const missed = [...scheduledStaffIds].filter(id => !loggedStaffIds.has(id) && staffById[id]);

  const totalVisits = Object.values(byStaff).reduce((a, b) => a + b.visits, 0);
  const totalSold = Object.values(byStaff).reduce((a, b) => a + b.sold, 0);
  const totalRevenue = Object.values(byStaff).reduce((a, b) => a + b.revenue, 0);

  const soldRows = Object.entries(byStaff)
    .map(([id, b]) => ({ name: staffById[id] ? staffById[id].name : 'Removed staff', ...b }))
    .sort((a, b) => b.sold - a.sold || b.revenue - a.revenue);

  const dateLabel = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const soldHtml = soldRows.length
    ? soldRows.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${r.visits}</td><td>${r.sold}</td><td>${fmtMoney(r.revenue)}</td></tr>`).join('')
    : '<tr><td colspan="4">No entries logged today.</td></tr>';

  const missedHtml = missed.length
    ? `<ul>${missed.map(id => `<li>${escapeHtml(staffById[id].name)}</li>`).join('')}</ul>`
    : '<p>Everyone scheduled today logged their tracker. Nice.</p>';

  const html = `
    <h2>Sauna House &mdash; Daily Report</h2>
    <p>${escapeHtml(dateLabel)}</p>
    <p><strong>Totals:</strong> ${totalVisits} visits, ${totalSold} sold, ${fmtMoney(totalRevenue)} revenue.</p>
    <h3>Who sold what</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <tr><th>Staff</th><th>Visits</th><th>Sold</th><th>Revenue</th></tr>
      ${soldHtml}
    </table>
    <h3>Didn't log a tracker today (scheduled)</h3>
    ${missedHtml}
  `;

  const text = [
    `Sauna House — Daily Report — ${dateLabel}`,
    `Totals: ${totalVisits} visits, ${totalSold} sold, ${fmtMoney(totalRevenue)} revenue.`,
    '',
    'Who sold what:',
    ...(soldRows.length ? soldRows.map(r => `- ${r.name}: ${r.visits} visits, ${r.sold} sold, ${fmtMoney(r.revenue)}`) : ['- No entries logged today.']),
    '',
    "Didn't log a tracker today (scheduled):",
    ...(missed.length ? missed.map(id => `- ${staffById[id].name}`) : ['- none, everyone logged']),
  ].join('\n');

  await sendEmail({
    to: process.env.REPORT_TO_EMAIL || 'manager@mysaunahouse.com',
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: `Sauna House daily report — ${dateLabel}`,
    html,
    text,
  });

  return { statusCode: 200, body: 'Report sent.' };
};
