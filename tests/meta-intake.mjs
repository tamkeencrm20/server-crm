/**
 * Acceptance checks for the Meta Lead Ads intake.
 *
 *   node tests/meta-intake.mjs
 *
 * Expects a seeded database, the API running on API_URL, and the same
 * META_APP_SECRET the server is using — every webhook here is signed exactly
 * as Meta signs one, so the signature path is exercised too.
 *
 * Outside production a delivery may carry its answers inline, which is what
 * lets these run the real intake path — mapping, branch fallback, dedupe,
 * distribution — without a live Graph token. Production always fetches.
 */
import crypto from 'node:crypto';
import 'dotenv/config';

const API = process.env.API_URL ?? 'http://localhost:5000';
const PASSWORD = process.env.TEAM_PASSWORD ?? process.env.SEED_PASSWORD ?? '12341234';
const ADMIN = process.env.TEST_ADMIN ?? 'mr.ali@tamkentrainingcrm.com';
const SECRET = process.env.META_APP_SECRET;

const AJMAN_PAGE = '258263244046358';
const DUBAI_PAGE = '463814543488570';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, ok: res.ok, body: json };
}

/** Post a webhook signed the way Meta signs it. */
async function deliver(value, pageId = AJMAN_PAGE) {
  const payload = {
    object: 'page',
    entry: [{ id: pageId, time: Date.now(), changes: [{ field: 'leadgen', value }] }],
  };
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const res = await fetch(`${API}/api/meta/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` },
    body: raw,
  });
  // The webhook answers before it does the work, so give the intake a moment.
  await sleep(1200);
  return res.status;
}

const field = (name, value) => ({ name, values: value === null ? [] : [value] });

async function findLead(token, leadgenId) {
  const events = await call(token, 'GET', '/meta/events?limit=200');
  const event = (events.body?.data ?? []).find((e) => e.leadgenId === leadgenId);
  if (!event?.lead) return { event, lead: null };
  // The detail endpoint answers { data: { lead, activities } }.
  const res = await call(token, 'GET', `/leads/${event.lead}`);
  return { event, lead: res.body?.data?.lead ?? null };
}

const run = async () => {
  if (!SECRET) {
    console.error('META_APP_SECRET is not set — the webhook cannot be signed. Aborting.');
    process.exit(1);
  }

  const stamp = Date.now().toString().slice(-8);
  const id = (suffix) => `test_${stamp}_${suffix}`;

  const admin = (await call(null, 'POST', '/auth/login', { email: ADMIN, password: PASSWORD })).body?.data;
  if (!admin?.accessToken) {
    console.error(`Could not sign in as ${ADMIN}. Set TEST_ADMIN / TEAM_PASSWORD.`);
    process.exit(1);
  }
  const t = admin.accessToken;

  // -------------------------------------------------------------------------
  section('1 · The old form, with Arabic field names and Arabic-Indic digits');
  {
    const leadgenId = id('old');
    await deliver({
      leadgen_id: leadgenId,
      page_id: AJMAN_PAGE,
      field_data: [
        field('الاسم_بالكامل', 'سالم المنصوري'),
        field('رقم_الهاتف', '٠٥٠٧٧٧٦٦٥٥'),
        field('من_اي_دولة_انت/انتِ', 'الإمارات'),
        field('اي_برنامج_ترغب_في_الاستفسار_عنه؟', 'اللغة الإنجليزية'),
      ],
    });

    const { event, lead } = await findLead(t, leadgenId);
    check('the delivery is recorded as processed', event?.status === 'processed', event?.lastError);
    check('the name survived', lead?.fullName === 'سالم المنصوري', lead?.fullName);
    check('the Arabic-Indic number became 971507776655', lead?.phone === '971507776655', lead?.phone);
    check('the country did not become the branch', lead?.branchRaw !== 'الإمارات', lead?.branchRaw);
    check('the course was read', Boolean(lead?.courseRaw), lead?.courseRaw);
  }

  // -------------------------------------------------------------------------
  section('2 · The new form, English field names and an explicit branch');
  {
    const leadgenId = id('new');
    await deliver({
      leadgen_id: leadgenId,
      page_id: AJMAN_PAGE,
      field_data: [
        field('full_name', 'Noura Test'),
        field('phone_number', `+9715066${stamp.slice(-5)}`),
        field('email', `noura.${stamp}@example.com`),
        field('الفرع', 'عجمان'),
      ],
    });

    const { lead } = await findLead(t, leadgenId);
    check('the lead exists', Boolean(lead), 'no lead was created');
    check('it landed in Ajman', lead?.branch?.code === 'ajman', lead?.branch?.code);
    check('it was assigned to an agent', Boolean(lead?.assignedTo), 'still unassigned');
    check('it is not flagged', !lead?.dataIssue, lead?.dataIssue);
  }

  // -------------------------------------------------------------------------
  section('3 · No phone number — the lead is kept, not dropped');
  {
    const leadgenId = id('nophone');
    const status = await deliver({
      leadgen_id: leadgenId,
      page_id: AJMAN_PAGE,
      field_data: [field('full_name', 'No Phone Person'), field('phone_number', null)],
    });

    check('the webhook still answered 200', status === 200, String(status));
    const { event, lead } = await findLead(t, leadgenId);
    check('the lead was stored', Boolean(lead), 'the lead was lost');
    check('it is flagged phone_missing', lead?.dataIssue === 'phone_missing', lead?.dataIssue);
    check('it is unassigned', !lead?.assignedTo, 'it was handed to an agent');
    check('the raw answers were kept', Boolean(event?.leadgenId), 'no event row');
  }

  // -------------------------------------------------------------------------
  section('4 · The Lead Ads Testing Tool');
  {
    const leadgenId = id('dummy');
    await deliver({
      leadgen_id: leadgenId,
      page_id: AJMAN_PAGE,
      field_data: [
        field('full_name', '<test lead: dummy data for full_name>'),
        field('phone_number', '<test lead: dummy data for phone_number>'),
      ],
    });

    const { event, lead } = await findLead(t, leadgenId);
    check('the delivery did not fail', event?.status === 'processed', event?.lastError);
    check('it is marked as a test lead', lead?.isTest === true, String(lead?.isTest));
    check('it never reached an agent', !lead?.assignedTo, 'it was assigned');
    check('it is hidden from the normal list', await hiddenFromList(t, leadgenId), 'it shows up');
  }

  // -------------------------------------------------------------------------
  section('5 · A Dubai page, on a form that never asks about branches');
  {
    const leadgenId = id('dubai');
    await deliver(
      {
        leadgen_id: leadgenId,
        page_id: DUBAI_PAGE,
        field_data: [
          field('full_name', 'Dubai Walker'),
          field('phone_number', `+9715055${stamp.slice(-5)}`),
          field('من_اي_دولة_انت/انتِ', 'مصر'),
        ],
      },
      DUBAI_PAGE,
    );

    const { lead } = await findLead(t, leadgenId);
    check('the lead exists', Boolean(lead), 'no lead was created');
    check('the page decided the branch: Dubai', lead?.branch?.code === 'dubai', lead?.branch?.code);
  }

  // -------------------------------------------------------------------------
  section('6 · A failed fetch is kept, and the retry recovers it');
  {
    // No inline answers and an unknown page: the Graph call cannot succeed,
    // which is exactly what an expired token looks like from here.
    const leadgenId = id('failed');
    await deliver({ leadgen_id: leadgenId, page_id: '999999999999999' }, '999999999999999');

    let { event } = await findLead(t, leadgenId);
    check('the event was recorded as failed', event?.status === 'failed', event?.status);
    check('the reason was kept', Boolean(event?.lastError), 'no error recorded');
    check('it is counted on the status screen', await failedCount(t) > 0, 'count is zero');

    // Recovery with the answers read out of Meta's own dashboard.
    const retry = await call(t, 'POST', `/meta/events/${leadgenId}/retry`, {
      fieldData: [
        { name: 'full_name', values: ['Recovered Lead'] },
        { name: 'phone_number', values: [`+9715044${stamp.slice(-5)}`] },
      ],
    });
    check('the retry reported success', retry.body?.data?.status === 'processed', JSON.stringify(retry.body));

    ({ event } = await findLead(t, leadgenId));
    check('the event is now processed', event?.status === 'processed', event?.status);
    const { lead } = await findLead(t, leadgenId);
    check('the lead finally exists', lead?.fullName === 'Recovered Lead', lead?.fullName);
  }

  // -------------------------------------------------------------------------
  section('7 · Repeat deliveries');
  {
    const leadgenId = id('dupe');
    // Unique per run: an earlier run's lead is still in the database.
    const repeatName = `Repeat Sender ${stamp}`;
    const body = {
      leadgen_id: leadgenId,
      page_id: AJMAN_PAGE,
      field_data: [
        field('full_name', repeatName),
        field('phone_number', `+9715033${stamp.slice(-5)}`),
      ],
    };
    await deliver(body);
    await deliver(body);

    const events = await call(t, 'GET', '/meta/events?limit=200');
    const rows = (events.body?.data ?? []).filter((e) => e.leadgenId === leadgenId);
    check('the same id produced one event row', rows.length === 1, `${rows.length} rows`);

    const leads = await call(t, 'GET', `/leads?search=${encodeURIComponent(repeatName)}&limit=50`);
    const mine = (leads.body?.data ?? []).filter((l) => l.fullName === repeatName);
    check('and exactly one lead', mine.length === 1, `${mine.length} leads`);
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(failed === 0 ? 0 : 1);
};

async function hiddenFromList(token, leadgenId) {
  const res = await call(token, 'GET', '/leads?limit=100&sort=newest');
  const rows = res.body?.data ?? [];
  return !rows.some((l) => l.meta?.leadgenId === leadgenId);
}

async function failedCount(token) {
  const res = await call(token, 'GET', '/meta/status');
  return res.body?.data?.failedEvents ?? 0;
}

run().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
