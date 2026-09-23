/**
 * End-to-end checks for the three features added on top of the original CRM:
 * the TikTok and Snapchat intakes, the media buyer role, and spreadsheet import.
 *
 *   node tests/features.mjs
 *
 * Expects a seeded database and the API running on API_URL (default :5000).
 */
import crypto from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:5000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Tamkeen@2026';

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

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function call(token, method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: res.ok, body: json };
}

async function login(email) {
  const res = await call(null, 'POST', '/auth/login', { email, password: PASSWORD });
  if (!res.ok) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Post a signed webhook exactly as the network would. */
async function signedWebhook(path, secret, header, payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const res = await fetch(`${API}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [header]: sig },
    body: raw,
  });
  return res.status;
}

const run = async () => {
  const stamp = Date.now().toString().slice(-7);

  const admin = await login('admin@tamkeentraining.com');
  const leader = await login('khalid.leader@tamkeentraining.com');
  const buyer = await login('hassan.media@tamkeentraining.com');
  const buyerDubai = await login('mariam.media@tamkeentraining.com');
  const agent = await login('ahmed.agent@tamkeentraining.com');

  const branches = (await call(admin.accessToken, 'GET', '/branches')).body.data;
  const ajman = branches.find((b) => b.code === 'ajman');
  const dubai = branches.find((b) => b.code === 'dubai');

  // -------------------------------------------------------------------------
  section('Setup — a pipeline to look at');
  // -------------------------------------------------------------------------

  // A freshly seeded database has no leads, so make a few and move one of them
  // along the pipeline; several checks below need more than one status present.
  for (let i = 0; i < 4; i += 1) {
    await call(admin.accessToken, 'POST', '/meta/simulate-lead', {
      fullName: `Setup ${i} ${stamp}`,
      phone: `0510${stamp}${i}`,
      branch: 'عجمان',
      course: 'KPI',
      platform: i % 2 ? 'ig' : 'fb',
    });
  }
  await call(admin.accessToken, 'POST', '/meta/simulate-lead', {
    fullName: `Setup dubai ${stamp}`, phone: `0511${stamp}`, branch: 'دبي', platform: 'fb',
  });

  const mine = await call(agent.accessToken, 'GET', '/leads?limit=1&status=new');
  const firstOwned = mine.body?.data?.[0];
  if (firstOwned) {
    await call(agent.accessToken, 'PATCH', `/leads/${firstOwned._id}/status`, { status: 'contacted', note: 'setup' });
  }
  check('setup produced a pipeline to inspect', Boolean(firstOwned), 'no lead reached the agent');

  // =========================================================================
  section('Media buyer — role and visibility');
  // =========================================================================

  check('signs in and is reported as media_buyer', buyer.user.role === 'media_buyer', buyer.user.role);
  check('is bound to a branch', Boolean(buyer.user.branch), JSON.stringify(buyer.user.branch));

  const buyerLeads = await call(buyer.accessToken, 'GET', '/leads?limit=100');
  check('reads the branch pipeline', buyerLeads.ok, `status ${buyerLeads.status}`);

  const outsideBranch = (buyerLeads.body?.data ?? []).filter(
    (l) => String(l.branch?._id ?? l.branch) !== String(ajman._id),
  );
  check('sees only its own branch', outsideBranch.length === 0, `${outsideBranch.length} foreign leads leaked`);

  const allStatuses = new Set((buyerLeads.body?.data ?? []).map((l) => l.status));
  check('sees every status, not just new', allStatuses.size >= 2, `statuses: ${[...allStatuses].join(',')}`);

  const buyerDash = await call(buyer.accessToken, 'GET', '/dashboard/overview');
  check('reads the branch dashboard', buyerDash.ok, `status ${buyerDash.status}`);

  const buyerAgents = await call(buyer.accessToken, 'GET', '/dashboard/agents');
  check('reads agent performance', buyerAgents.ok, `status ${buyerAgents.status}`);

  const buyerSources = await call(buyer.accessToken, 'GET', '/dashboard/sources');
  check('gets a per-network breakdown', Array.isArray(buyerSources.body?.data?.byPlatform), JSON.stringify(buyerSources.body?.data && Object.keys(buyerSources.body.data)));

  // Cross-branch isolation
  const dubaiLeads = await call(buyerDubai.accessToken, 'GET', '/leads?limit=100');
  const dubaiForeign = (dubaiLeads.body?.data ?? []).filter(
    (l) => String(l.branch?._id ?? l.branch) !== String(dubai._id),
  );
  check('the Dubai buyer sees only Dubai', dubaiForeign.length === 0, `${dubaiForeign.length} leaked`);

  const crossBranch = await call(buyer.accessToken, 'GET', `/dashboard/overview?branch=${dubai._id}`);
  check('cannot read another branch by query param', crossBranch.status === 403, `status ${crossBranch.status}`);

  // =========================================================================
  section('Media buyer — what it must NOT be able to do');
  // =========================================================================

  const someLead = (buyerLeads.body?.data ?? [])[0];

  const tryStatus = await call(buyer.accessToken, 'PATCH', `/leads/${someLead._id}/status`, { status: 'contacted' });
  check('cannot change a lead status', tryStatus.status === 403, `status ${tryStatus.status}`);

  const tryActivity = await call(buyer.accessToken, 'POST', `/leads/${someLead._id}/activities`, { type: 'note', note: 'x' });
  check('cannot log activity on a lead', tryActivity.status === 403, `status ${tryActivity.status}`);

  const tryAssign = await call(buyer.accessToken, 'POST', `/leads/${someLead._id}/assign`, { agentId: agent.user.id ?? agent.user._id });
  check('cannot reassign a lead', tryAssign.status === 403, `status ${tryAssign.status}`);

  const tryCreateUser = await call(buyer.accessToken, 'POST', '/users', {
    name: 'Nope', email: `nope${stamp}@tamkeentraining.com`, password: 'Password123', role: 'agent', branch: ajman._id,
  });
  check('cannot create users', tryCreateUser.status === 403, `status ${tryCreateUser.status}`);

  const tryBranch = await call(buyer.accessToken, 'POST', '/branches', { code: `x${stamp}`, name: { ar: 'س', en: 'X' } });
  check('cannot create branches', tryBranch.status === 403, `status ${tryBranch.status}`);

  const tryDistribute = await call(buyer.accessToken, 'POST', '/leads/distribute/unassigned');
  check('cannot trigger distribution', tryDistribute.status === 403, `status ${tryDistribute.status}`);

  // A team leader must not be able to manage the media buyer either.
  const buyerId = buyer.user.id ?? buyer.user._id;
  const leaderTouchesBuyer = await call(leader.accessToken, 'PATCH', `/users/${buyerId}`, { isActive: false });
  check('a team leader cannot disable the media buyer', leaderTouchesBuyer.status === 403, `status ${leaderTouchesBuyer.status}`);

  // =========================================================================
  section('Media buyer — platform control');
  // =========================================================================

  for (const platform of ['meta', 'tiktok', 'snapchat']) {
    const status = await call(buyer.accessToken, 'GET', `/${platform}/status`);
    check(`reads ${platform} integration status`, status.ok, `status ${status.status}`);
  }

  const agentPlatform = await call(agent.accessToken, 'GET', '/tiktok/status');
  check('an agent cannot read platform status', agentPlatform.status === 403, `status ${agentPlatform.status}`);

  const leaderPlatform = await call(leader.accessToken, 'GET', '/tiktok/status');
  check('a team leader cannot read platform status', leaderPlatform.status === 403, `status ${leaderPlatform.status}`);

  // =========================================================================
  section('TikTok and Snapchat intake');
  // =========================================================================

  for (const platform of ['tiktok', 'snapchat']) {
    const sim = await call(buyer.accessToken, 'POST', `/${platform}/simulate-lead`, {
      fullName: `${platform} probe ${stamp}`,
      phone: `05${platform === 'tiktok' ? '55' : '66'}${stamp}`,
      branch: 'عجمان',
      course: 'KPI',
      campaignName: `${platform} test campaign`,
    });
    check(`${platform}: simulated lead is created`, sim.status === 201, `status ${sim.status} ${JSON.stringify(sim.body?.error ?? '')}`);
    check(`${platform}: it gets auto-assigned`, Boolean(sim.body?.data?.assignedTo), JSON.stringify(sim.body?.data));

    if (sim.body?.data?.leadId) {
      const detail = await call(admin.accessToken, 'GET', `/leads/${sim.body.data.leadId}`);
      const lead = detail.body?.data?.lead;
      check(`${platform}: source is recorded as ${platform}`, lead?.source === platform, lead?.source);
      check(`${platform}: network is tagged`, lead?.meta?.network === platform, lead?.meta?.network);
      check(`${platform}: the branch resolved from Arabic text`, String(lead?.branch?._id ?? lead?.branch) === String(ajman._id), 'branch mismatch');
      check(`${platform}: the course matched the catalogue`, Boolean(lead?.course), 'course not linked');
    }
  }

  // Signature enforcement — the security property that matters most.
  const badSig = await fetch(`${API}/api/tiktok/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tt-signature': 'deadbeef' },
    body: JSON.stringify({ event: 'lead', data: { lead_id: '1' } }),
  });
  check('an unsigned TikTok webhook is rejected', badSig.status === 401, `status ${badSig.status}`);

  const badSnap = await fetch(`${API}/api/snapchat/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-snap-signature': 'sha256=deadbeef' },
    body: JSON.stringify({ leads: [{ id: '1' }] }),
  });
  check('an unsigned Snapchat webhook is rejected', badSnap.status === 401, `status ${badSnap.status}`);

  const noSig = await fetch(`${API}/api/snapchat/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('a Snapchat webhook with no signature is rejected', noSig.status === 401, `status ${noSig.status}`);

  // =========================================================================
  section('Spreadsheet import — per role');
  // =========================================================================

  // Each sheet gets its own numeric band so two different sheets never mint the
  // same phone number — otherwise the dedupe would correctly reject the second
  // sheet and the test would be measuring its own collision.
  const bands = {};
  let nextBand = 0;
  const sheet = (prefix, n) => {
    if (bands[prefix] === undefined) {
      nextBand += 1;
      bands[prefix] = nextBand;
    }
    const band = String(bands[prefix]).padStart(2, '0');
    return Array.from({ length: n }, (_, i) => ({
      'الاسم': `${prefix} ${i} ${stamp}`,
      'رقم الهاتف': `05${band}${stamp}${String(i).padStart(2, '0')}`,
      'البريد الإلكتروني': `${prefix}${i}${stamp}@example.com`,
      'الدورة': 'KPI',
      'ملاحظات': 'عميل سابق',
    }));
  };

  // Dry run writes nothing.
  const before = (await call(admin.accessToken, 'GET', '/leads?limit=1')).body.pagination.total;
  const dry = await call(admin.accessToken, 'POST', '/leads/import', { rows: sheet('dry', 3), branch: ajman._id, dryRun: true });
  const afterDry = (await call(admin.accessToken, 'GET', '/leads?limit=1')).body.pagination.total;
  check('a dry run validates without writing', dry.ok && afterDry === before, `${before} -> ${afterDry}`);

  // Admin import spreads across the branch team.
  const adminImport = await call(admin.accessToken, 'POST', '/leads/import', { rows: sheet('adm', 6), branch: ajman._id });
  check('admin import succeeds', adminImport.status === 201, `status ${adminImport.status} ${JSON.stringify(adminImport.body?.error ?? '')}`);
  check('admin import creates every row', adminImport.body?.data?.summary?.created === 6, JSON.stringify(adminImport.body?.data?.summary));
  const owners = new Set((adminImport.body?.data?.results ?? []).map((r) => r.assignedTo).filter(Boolean));
  check('admin import spreads across several agents', owners.size > 1, `owners: ${[...owners].join(', ')}`);

  // Admin must name a branch.
  const noBranch = await call(admin.accessToken, 'POST', '/leads/import', { rows: sheet('nb', 1) });
  check('admin import without a branch is refused', noBranch.status === 400, `status ${noBranch.status}`);

  // Agent import stays with the agent.
  const agentImport = await call(agent.accessToken, 'POST', '/leads/import', { rows: sheet('agt', 4) });
  check('agent import succeeds', agentImport.status === 201, `status ${agentImport.status}`);
  check('agent import keeps every row', agentImport.body?.data?.summary?.created === 4, JSON.stringify(agentImport.body?.data?.summary));
  check('agent import is flagged as kept by the uploader', agentImport.body?.data?.keptByUploader === true, JSON.stringify(agentImport.body?.data?.keptByUploader));

  const agentOwners = new Set((agentImport.body?.data?.results ?? []).map((r) => r.assignedTo).filter(Boolean));
  check('agent import goes to nobody else', agentOwners.size === 1 && agentOwners.has(agent.user.name), `owners: ${[...agentOwners].join(', ')}`);

  // An agent cannot aim an import at another branch.
  const agentOtherBranch = await call(agent.accessToken, 'POST', '/leads/import', { rows: sheet('ab', 1), branch: dubai._id });
  check('agent import ignores a foreign branch request', agentOtherBranch.status === 201, `status ${agentOtherBranch.status}`);

  // Leader import stays inside the leader's branch.
  const leaderImport = await call(leader.accessToken, 'POST', '/leads/import', { rows: sheet('ldr', 4) });
  check('team leader import succeeds', leaderImport.status === 201, `status ${leaderImport.status}`);
  const leaderCrossBranch = await call(leader.accessToken, 'POST', '/leads/import', { rows: sheet('lx', 1), branch: dubai._id });
  check('team leader cannot import into another branch', leaderCrossBranch.status === 403, `status ${leaderCrossBranch.status}`);

  // Media buyer import lands in their branch.
  const buyerImport = await call(buyer.accessToken, 'POST', '/leads/import', { rows: sheet('mb', 3) });
  check('media buyer import succeeds', buyerImport.status === 201, `status ${buyerImport.status}`);

  // Validation and dedupe.
  const messy = await call(admin.accessToken, 'POST', '/leads/import', {
    branch: ajman._id,
    rows: [
      { 'الاسم': '', 'رقم الهاتف': '0501111111' },
      { 'الاسم': 'No Phone Person', 'رقم الهاتف': '' },
      { 'الاسم': `Dupe ${stamp}`, 'رقم الهاتف': `0577${stamp}` },
      { 'الاسم': `Dupe again ${stamp}`, 'رقم الهاتف': `0577${stamp}` },
    ],
  });
  const ms = messy.body?.data?.summary;
  check('a row with no name is rejected', ms?.invalid >= 1, JSON.stringify(ms));
  check('a row with no phone is rejected', ms?.invalid === 2, JSON.stringify(ms));
  check('a repeat inside the file is caught', ms?.duplicate === 1, JSON.stringify(ms));
  check('the good row still imports', ms?.created === 1, JSON.stringify(ms));

  // Re-importing the same file finds them already present.
  const again = await call(admin.accessToken, 'POST', '/leads/import', { rows: sheet('adm', 6), branch: ajman._id });
  check('re-importing the same sheet creates nothing', again.body?.data?.summary?.created === 0, JSON.stringify(again.body?.data?.summary));
  check('re-importing reports them as duplicates', again.body?.data?.summary?.duplicate === 6, JSON.stringify(again.body?.data?.summary));

  // English headers must work as well as Arabic.
  const english = await call(admin.accessToken, 'POST', '/leads/import', {
    branch: ajman._id,
    rows: [{ 'Full Name': `English Header ${stamp}`, 'Phone Number': `0588${stamp}`, Email: `en${stamp}@example.com`, Course: 'PMP' }],
  });
  check('English column headers are understood', english.body?.data?.summary?.created === 1, JSON.stringify(english.body?.data?.summary));

  // Row limit.
  const huge = await call(admin.accessToken, 'POST', '/leads/import', {
    rows: Array.from({ length: 5001 }, (_, i) => ({ name: `x${i}`, phone: `05${i}` })),
    branch: ajman._id,
  });
  check('an oversized sheet is refused', huge.status === 400, `status ${huge.status}`);

  // =========================================================================
  section('Media buyer is invisible to a team leader');
  // =========================================================================

  const leaderTeam = await call(leader.accessToken, 'GET', '/users?limit=50');
  const buyersSeen = (leaderTeam.body?.data ?? []).filter((u) => u.role === 'media_buyer');
  check('a team leader does not see media buyers at all', buyersSeen.length === 0, `${buyersSeen.length} visible`);

  // The scope must survive a caller-supplied role filter.
  const leaderProbe = await call(leader.accessToken, 'GET', '/users?role=media_buyer&limit=50');
  check('?role=media_buyer cannot bypass the scope', (leaderProbe.body?.data ?? []).length === 0, `${leaderProbe.body?.data?.length} leaked`);

  const leaderAgents = await call(leader.accessToken, 'GET', '/users?role=agent&limit=50');
  check('a normal role filter still works for a leader', (leaderAgents.body?.data ?? []).length > 0, 'no agents returned');

  const buyerById = await call(leader.accessToken, 'GET', `/users/${buyerId}`);
  check('a team leader cannot open the media buyer by id', buyerById.status === 404, `status ${buyerById.status}`);

  const adminSeesBuyers = await call(admin.accessToken, 'GET', '/users?role=media_buyer&limit=50');
  check('an admin still sees media buyers', (adminSeesBuyers.body?.data ?? []).length === 2, `${adminSeesBuyers.body?.data?.length} found`);

  // =========================================================================
  section('Spreadsheet export — per role');
  // =========================================================================

  const exportAs = async (tok, query = '') => call(tok.accessToken, 'GET', `/leads/export${query}`);

  const adminExport = await exportAs(admin);
  check('admin can export', adminExport.ok, `status ${adminExport.status}`);
  check('admin export has a column list', Array.isArray(adminExport.body?.data?.columns) && adminExport.body.data.columns.length > 10, JSON.stringify(adminExport.body?.data?.columns?.length));

  const leaderExport = await exportAs(leader);
  check('team leader can export', leaderExport.ok, `status ${leaderExport.status}`);
  const leaderBranches = new Set((leaderExport.body?.data?.rows ?? []).map((r) => r.branch));
  check('leader export is one branch only', leaderBranches.size <= 1, `branches: ${[...leaderBranches].join(', ')}`);

  const agentExport = await exportAs(agent);
  check('agent can export', agentExport.ok, `status ${agentExport.status}`);
  const agentOwnersInFile = new Set((agentExport.body?.data?.rows ?? []).map((r) => r.assignedTo));
  check('agent export contains only their own leads', agentOwnersInFile.size <= 1, `owners: ${[...agentOwnersInFile].join(', ')}`);
  check('agent export is smaller than the admin one', (agentExport.body?.data?.total ?? 0) < (adminExport.body?.data?.total ?? 0), `${agentExport.body?.data?.total} vs ${adminExport.body?.data?.total}`);

  const buyerExport = await exportAs(buyer);
  check('media buyer can export what it can read', buyerExport.ok, `status ${buyerExport.status}`);

  // Filters must reach the file, not just the screen.
  const filteredExport = await exportAs(admin, '?status=new');
  const statuses = new Set((filteredExport.body?.data?.rows ?? []).map((r) => r.status));
  check('export honours the status filter', statuses.size === 1 && statuses.has('new'), `statuses: ${[...statuses].join(',')}`);
  check('the filtered export is smaller than the full one', filteredExport.body.data.total < adminExport.body.data.total, `${filteredExport.body.data.total} vs ${adminExport.body.data.total}`);

  // The row shape the workbook builder depends on.
  const sample = adminExport.body?.data?.rows?.[0] ?? {};
  check('rows carry a readable phone', /^\+/.test(sample.phone ?? ''), sample.phone);
  for (const field of ['fullName', 'status', 'source', 'branch', 'assignedTo', 'createdAt']) {
    check(`rows carry ${field}`, field in sample, `missing from ${Object.keys(sample).join(',')}`);
  }

  // /export must not be swallowed by the /:id route.
  check('the export route is not read as a lead id', adminExport.body?.error?.code !== 'INVALID_ID', JSON.stringify(adminExport.body?.error));

  // =========================================================================
  section('Regressions — the original behaviour still holds');
  // =========================================================================

  const agentLeads = await call(agent.accessToken, 'GET', '/leads?limit=100');
  const notMine = (agentLeads.body?.data ?? []).filter((l) => String(l.assignedTo?._id ?? l.assignedTo) !== String(agent.user.id ?? agent.user._id));
  check('an agent still sees only their own leads', notMine.length === 0, `${notMine.length} foreign leads`);

  const leaderStill = await call(leader.accessToken, 'POST', '/leads/distribute/unassigned');
  check('a team leader can still distribute', leaderStill.ok, `status ${leaderStill.status}`);

  const metaSim = await call(admin.accessToken, 'POST', '/meta/simulate-lead', {
    fullName: `Meta probe ${stamp}`, phone: `0599${stamp}`, branch: 'عجمان', platform: 'ig',
  });
  check('the Meta path still works', metaSim.status === 201, `status ${metaSim.status}`);
  if (metaSim.body?.data?.leadId) {
    const l = (await call(admin.accessToken, 'GET', `/leads/${metaSim.body.data.leadId}`)).body?.data?.lead;
    check('Meta leads are tagged with their network too', l?.meta?.network === 'meta', l?.meta?.network);
  }

  const pipeline = await call(agent.accessToken, 'GET', '/leads/stats/pipeline');
  check('the pipeline counter still responds', pipeline.ok, `status ${pipeline.status}`);

  // =========================================================================
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f}`));
  }
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
