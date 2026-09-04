const API = 'http://localhost:5000/api';
const PW = 'Tamkeen@2026';
let pass = 0, fail = 0;

const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`); }
};

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const login = async (email) => {
  const r = await call('/auth/login', { method: 'POST', body: { email, password: PW } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.json)}`);
  return r.json.data;
};

console.log('\n=== 1. Authentication ===');
const admin = await login('admin@tamkeentraining.com');
ok('admin signs in', admin.accessToken && admin.user.role === 'admin');
ok('password hash is not returned', admin.user.passwordHash === undefined);

const leaderAjman = await login('khalid.leader@tamkeentraining.com');
const agentAhmed = await login('ahmed.agent@tamkeentraining.com');
const agentLayla = await login('layla.agent@tamkeentraining.com');
ok('team leader signs in', leaderAjman.user.role === 'team_leader');
ok('agent signs in', agentAhmed.user.role === 'agent');

const bad = await call('/auth/login', { method: 'POST', body: { email: 'admin@tamkeentraining.com', password: 'wrong' } });
ok('wrong password is rejected', bad.status === 401, `got ${bad.status}`);

const noToken = await call('/leads');
ok('unauthenticated request is rejected', noToken.status === 401, `got ${noToken.status}`);

console.log('\n=== 2. Reference data ===');
const branches = await call('/branches', { token: admin.accessToken });
ok('two branches seeded', branches.json.data.length === 2);
const ajman = branches.json.data.find((b) => b.code === 'ajman');
const dubai = branches.json.data.find((b) => b.code === 'dubai');

const courses = await call('/courses', { token: admin.accessToken });
ok('six courses seeded', courses.json.data.length === 6, `got ${courses.json.data.length}`);

console.log('\n=== 3. Round-robin distribution (the 2-2-2 rule) ===');
// Ajman has exactly 3 agents. Nine leads should land 3 / 3 / 3.
const names = ['Mohammed A', 'Noura B', 'Saeed C', 'Hind D', 'Tariq E', 'Reem F', 'Jassim G', 'Maha H', 'Bilal I'];
const created = [];
for (let i = 0; i < names.length; i++) {
  const r = await call('/meta/simulate-lead', {
    method: 'POST',
    token: admin.accessToken,
    body: { fullName: names[i], phone: `05012345${String(i).padStart(2, '0')}`, branch: 'عجمان', course: 'KPI', platform: i % 2 ? 'ig' : 'fb' },
  });
  if (r.status !== 201) { console.log('   simulate failed:', r.status, JSON.stringify(r.json)); break; }
  created.push(r.json.data);
}
ok('nine simulated Meta leads created', created.length === 9, `got ${created.length}`);
ok('every lead got an owner', created.every((c) => c.assignedTo), JSON.stringify(created.map(c=>c.assignedTo)));

const tally = {};
created.forEach((c) => { tally[c.assignedTo] = (tally[c.assignedTo] ?? 0) + 1; });
console.log('   distribution:', JSON.stringify(tally));
const counts = Object.values(tally).sort();
ok('spread evenly 3/3/3 across the three Ajman agents', counts.length === 3 && counts.every((n) => n === 3), JSON.stringify(counts));
console.log('   reason sample:', created[0].reason);

console.log('\n=== 4. Duplicate protection ===');
const dup = await call('/meta/simulate-lead', {
  method: 'POST', token: admin.accessToken,
  body: { fullName: 'Mohammed A again', phone: '0501234500', branch: 'عجمان', course: 'KPI' },
});
ok('same phone is recognised as a duplicate', dup.json.data?.duplicate === true, JSON.stringify(dup.json));

const dupIntl = await call('/meta/simulate-lead', {
  method: 'POST', token: admin.accessToken,
  body: { fullName: 'Mohammed A intl', phone: '+971 50 123 4500', branch: 'عجمان' },
});
ok('same number in international format is also caught', dupIntl.json.data?.duplicate === true);

console.log('\n=== 5. Role scoping ===');
const adminLeads = await call('/leads?limit=100', { token: admin.accessToken });
const leaderLeads = await call('/leads?limit=100', { token: leaderAjman.accessToken });
const ahmedLeads = await call('/leads?limit=100', { token: agentAhmed.accessToken });
const laylaLeads = await call('/leads?limit=100', { token: agentLayla.accessToken });

ok('admin sees all 9 leads', adminLeads.json.pagination.total === 9, `got ${adminLeads.json.pagination.total}`);
ok('Ajman leader sees all 9 Ajman leads', leaderLeads.json.pagination.total === 9, `got ${leaderLeads.json.pagination.total}`);
ok('Ajman agent sees only his own 3', ahmedLeads.json.pagination.total === 3, `got ${ahmedLeads.json.pagination.total}`);
ok('Dubai agent sees none of the Ajman leads', laylaLeads.json.pagination.total === 0, `got ${laylaLeads.json.pagination.total}`);

const crossBranch = await call(`/leads?branch=${ajman._id}`, { token: agentLayla.accessToken });
ok('Dubai agent cannot filter into Ajman', crossBranch.json.pagination.total === 0);

const dashAsAgent = await call('/dashboard/branches', { token: agentAhmed.accessToken });
ok('agent is blocked from branch comparison', dashAsAgent.status === 403, `got ${dashAsAgent.status}`);

console.log('\n=== 6. Pipeline transitions ===');
const myLead = ahmedLeads.json.data[0];
const st1 = await call(`/leads/${myLead._id}/status`, { method: 'PATCH', token: agentAhmed.accessToken, body: { status: 'contacted', note: 'Called, interested in KPI' } });
ok('new -> contacted allowed', st1.status === 200, JSON.stringify(st1.json));
ok('firstContactedAt was stamped', Boolean(st1.json.data?.firstContactedAt));
ok('contactAttempts incremented', st1.json.data?.contactAttempts === 1);

const illegal = await call(`/leads/${ahmedLeads.json.data[1]._id}/status`, { method: 'PATCH', token: agentAhmed.accessToken, body: { status: 'enrolled' } });
ok('new -> enrolled is refused', illegal.status === 400 && illegal.json.error.code === 'INVALID_TRANSITION', JSON.stringify(illegal.json));

const noDate = await call(`/leads/${myLead._id}/status`, { method: 'PATCH', token: agentAhmed.accessToken, body: { status: 'follow_up' } });
ok('follow_up without a date is refused', noDate.status === 400 && noDate.json.error.code === 'FOLLOW_UP_DATE_REQUIRED');

const withDate = await call(`/leads/${myLead._id}/status`, { method: 'PATCH', token: agentAhmed.accessToken, body: { status: 'follow_up', nextFollowUpAt: new Date(Date.now() + 86400000).toISOString(), note: 'Call back tomorrow' } });
ok('follow_up with a date is accepted', withDate.status === 200);

const enrol = await call(`/leads/${myLead._id}/status`, { method: 'PATCH', token: agentAhmed.accessToken, body: { status: 'enrolled', dealValue: 3500, note: 'Paid in full' } });
ok('follow_up -> enrolled allowed', enrol.status === 200);
ok('enrolledAt stamped and deal value stored', Boolean(enrol.json.data?.enrolledAt) && enrol.json.data?.dealValue === 3500);

const foreign = await call(`/leads/${myLead._id}/status`, { method: 'PATCH', token: agentLayla.accessToken, body: { status: 'closed' } });
ok('another agent cannot touch this lead', foreign.status === 403, `got ${foreign.status}`);

console.log('\n=== 7. Activity timeline ===');
const detail = await call(`/leads/${myLead._id}`, { token: agentAhmed.accessToken });
const types = detail.json.data.activities.map((a) => a.type);
console.log('   timeline:', types.join(' <- '));
ok('assignment + status changes are all logged', types.filter(t => t === 'status_change').length === 3 && types.includes('assignment'));

const note = await call(`/leads/${myLead._id}/activities`, { method: 'POST', token: agentAhmed.accessToken, body: { type: 'call', note: 'Confirmed start date', callOutcome: 'answered', callDurationSeconds: 180 } });
ok('agent can log a call', note.status === 201);

const spoof = await call(`/leads/${myLead._id}/activities`, { method: 'POST', token: agentAhmed.accessToken, body: { type: 'status_change', note: 'fake' } });
ok('client cannot forge a status_change entry', spoof.status === 400);

console.log('\n=== 8. Reassignment + audit trail ===');
const target = ahmedLeads.json.data[1];
const reassign = await call(`/leads/${target._id}/assign`, { method: 'POST', token: leaderAjman.accessToken, body: { agentId: laylaLeads.json.data.length ? agentLayla.user.id : agentAhmed.user.id } });
// Layla is in Dubai; leader should still be able to move within his own branch only.
const audit = await call(`/leads/${target._id}/assignments`, { token: leaderAjman.accessToken });
ok('assignment history is readable by the leader', audit.status === 200 && audit.json.data.length >= 1, JSON.stringify(audit.json).slice(0, 200));
console.log('   audit reason:', audit.json.data?.[0]?.reason);

const agentAudit = await call(`/leads/${myLead._id}/assignments`, { token: agentAhmed.accessToken });
ok('agent cannot read the distribution audit', agentAudit.status === 403, `got ${agentAudit.status}`);

console.log('\n=== 9. Availability gate ===');
await call('/users/me/availability', { method: 'PATCH', token: agentAhmed.accessToken, body: { isAvailable: false } });
const afterOff = [];
for (let i = 0; i < 4; i++) {
  const r = await call('/meta/simulate-lead', { method: 'POST', token: admin.accessToken, body: { fullName: `Offshift ${i}`, phone: `05099887${String(i).padStart(2, '0')}`, branch: 'عجمان' } });
  afterOff.push(r.json.data?.assignedTo);
}
console.log('   went to:', JSON.stringify(afterOff));
ok('an unavailable agent receives nothing', !afterOff.includes('Ahmed Mansour'), JSON.stringify(afterOff));
ok('the two remaining agents split them', new Set(afterOff).size === 2);
await call('/users/me/availability', { method: 'PATCH', token: agentAhmed.accessToken, body: { isAvailable: true } });

console.log('\n=== 10. Dashboard KPIs ===');
const ov = await call('/dashboard/overview', { token: admin.accessToken });
const o = ov.json.data.overview;
console.log(`   total=${o.totalLeads} enrolled=${o.enrolled} conversion=${o.conversionRate}% revenue=${o.revenue} response=${o.responseRate}% avg=${o.avgResponseMinutes}min`);
ok('overview returns real numbers', o.totalLeads === 13 && o.enrolled === 1, `total=${o.totalLeads} enrolled=${o.enrolled}`);
ok('revenue attributed from the enrolment', o.revenue === 3500, `got ${o.revenue}`);
ok('trend has one point per day', ov.json.data.trend.length === 30, `got ${ov.json.data.trend.length}`);

const agents = await call('/dashboard/agents', { token: leaderAjman.accessToken });
ok('agent leaderboard is scoped to the branch', agents.json.data.length === 3, `got ${agents.json.data.length}`);
console.log('   top agent:', JSON.stringify(agents.json.data[0]?.name), agents.json.data[0]?.leads, 'leads');

const branchPerf = await call('/dashboard/branches', { token: admin.accessToken });
ok('branch comparison works for admin', branchPerf.status === 200);

const sources = await call('/dashboard/sources', { token: admin.accessToken });
ok('source breakdown splits fb/ig', sources.json.data.bySource.length >= 2, JSON.stringify(sources.json.data.bySource));

console.log('\n=== 11. Notifications ===');
const notifs = await call('/notifications', { token: agentAhmed.accessToken });
ok('agent received lead-assigned notifications', notifs.json.pagination.total >= 3, `got ${notifs.json.pagination.total}`);
ok('notifications are bilingual', Boolean(notifs.json.data[0]?.title?.ar && notifs.json.data[0]?.title?.en), JSON.stringify(notifs.json.data[0]?.title));
console.log('   sample:', notifs.json.data[0]?.title?.ar, '|', notifs.json.data[0]?.title?.en);

const enrolNotif = await call('/notifications', { token: leaderAjman.accessToken });
ok('leader was told about the enrolment', enrolNotif.json.data.some((n) => n.type === 'lead_enrolled'));

console.log('\n=== 12. Meta webhook security ===');
const wh = await fetch(`${API}/meta/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object: 'page', entry: [] }) });
ok('unsigned webhook delivery is rejected', wh.status === 401, `got ${wh.status}`);

const verifyBad = await fetch(`${API}/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`);
ok('webhook verification with a bad token is rejected', verifyBad.status === 403, `got ${verifyBad.status}`);

console.log(`\n${'='.repeat(46)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(46));
process.exit(fail ? 1 : 0);
