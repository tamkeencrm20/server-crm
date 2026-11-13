/**
 * Fills a seeded database with a believable working day, so every screen has
 * something real to show: leads from all three ad networks, a pipeline spread
 * across the statuses, overdue follow-ups, enrolments with revenue, an
 * unassigned queue to drain, and an imported batch.
 *
 *   npm run seed:demo          add demo leads to the current data
 *   npm run seed:demo -- --reset   reseed the base data first
 *
 * Runs against the live API rather than the database directly, so every lead
 * travels the same intake path a real one does — distribution, audit rows,
 * activity timeline and all.
 */
import { spawnSync } from 'node:child_process';
import env from '../src/config/env.js';
import logger from '../src/utils/logger.js';

const API = process.env.API_URL ?? `http://localhost:${env.PORT}`;
const PASSWORD = process.env.SEED_PASSWORD ?? 'Tamkeen@2026';

if (process.argv.includes('--reset')) {
  logger.info('Reseeding the base data first…');
  const r = spawnSync(process.execPath, ['seed/seed.js', '--reset'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const call = async (token, method, path, body) => {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json?.error ?? '')}`);
  return json;
};

const login = async (email) => (await call(null, 'POST', '/auth/login', { email, password: PASSWORD })).data;

const AR_NAMES = [
  'محمد عبدالله', 'نورة السويدي', 'سعيد الحمادي', 'هند المرزوقي', 'طارق الشامسي',
  'ريم الكعبي', 'جاسم الفلاسي', 'مريم الظاهري', 'خالد النعيمي', 'عائشة البلوشي',
  'يوسف الحوسني', 'شيخة الرميثي', 'عبدالرحمن الكندي', 'لطيفة المهيري', 'حمد الشحي',
  'سلمى العامري', 'ماجد البدواوي', 'أمل الجنيبي', 'فيصل الطنيجي', 'دانة الشامسي',
];

const COURSES = ['KPI', 'PMP', 'HR', 'OSH', 'ENTR', 'HOSPQ'];
const CAMPAIGNS = {
  meta: ['حملة مؤشرات الأداء', 'حملة إدارة المشاريع'],
  tiktok: ['تيك توك — الموارد البشرية', 'تيك توك — ريادة الأعمال'],
  snapchat: ['سناب — السلامة المهنية', 'سناب — جودة المستشفيات'],
};

const pick = (arr, i) => arr[i % arr.length];

async function main() {
  logger.info(`Seeding demo activity against ${API}`);

  const admin = await login('admin@tamkeentraining.com');
  const buyerAjman = await login('hassan.media@tamkeentraining.com');
  const buyerDubai = await login('mariam.media@tamkeentraining.com');

  const branches = (await call(admin.accessToken, 'GET', '/branches')).data;
  const ajman = branches.find((b) => b.code === 'ajman');
  const dubai = branches.find((b) => b.code === 'dubai');
  if (!ajman || !dubai) throw new Error('Run `npm run seed` first — the branches are missing');

  const stamp = Date.now().toString().slice(-6);
  let phone = 0;
  const nextPhone = () => `05${String(phone++).padStart(2, '0')}${stamp}`;

  // ---- 1. Leads from all three networks, both branches --------------------
  const created = [];
  let i = 0;

  for (const [network, branchName, token] of [
    ['meta', 'عجمان', buyerAjman],
    ['tiktok', 'عجمان', buyerAjman],
    ['snapchat', 'عجمان', buyerAjman],
    ['meta', 'دبي', buyerDubai],
    ['tiktok', 'دبي', buyerDubai],
  ]) {
    for (let n = 0; n < 4; n += 1) {
      const path = network === 'meta' ? '/meta/simulate-lead' : `/${network}/simulate-lead`;
      const body = {
        fullName: pick(AR_NAMES, i),
        phone: nextPhone(),
        email: `lead${i}@example.com`,
        branch: branchName,
        course: pick(COURSES, i),
        ...(network === 'meta'
          ? { platform: n % 2 ? 'ig' : 'fb' }
          : { campaignName: pick(CAMPAIGNS[network], n) }),
      };
      // Meta's simulator is admin-gated by history; the other two accept the buyer.
      const res = await call(network === 'meta' ? admin.accessToken : token.accessToken, 'POST', path, body);
      created.push({ id: res.data.leadId, network, branch: branchName });
      i += 1;
    }
  }
  logger.info(`  ${created.length} leads created across meta / tiktok / snapchat`);

  // ---- 2. Move some of them through the pipeline ---------------------------
  const agents = ['ahmed.agent@tamkeentraining.com', 'fatima.agent@tamkeentraining.com', 'layla.agent@tamkeentraining.com'];
  const tomorrow = new Date(Date.now() + 26 * 3600_000).toISOString();
  const yesterday = new Date(Date.now() - 20 * 3600_000).toISOString();

  let contacted = 0;
  let enrolled = 0;
  let overdue = 0;

  for (const email of agents) {
    const agent = await login(email);
    const mine = (await call(agent.accessToken, 'GET', '/leads?status=new&limit=10')).data;

    for (let n = 0; n < mine.length; n += 1) {
      const lead = mine[n];
      await call(agent.accessToken, 'POST', `/leads/${lead._id}/activities`, {
        type: 'call',
        note: 'اتصال أولي، شرح تفاصيل الدورة',
        callOutcome: 'answered',
        callDurationSeconds: 90 + n * 30,
      });
      await call(agent.accessToken, 'PATCH', `/leads/${lead._id}/status`, { status: 'contacted', note: 'مهتم مبدئياً' });
      contacted += 1;

      if (n === 0) {
        await call(agent.accessToken, 'PATCH', `/leads/${lead._id}/status`, { status: 'interested' });
        await call(agent.accessToken, 'PATCH', `/leads/${lead._id}/status`, {
          status: 'enrolled',
          dealValue: 3500 + n * 500,
          note: 'تم الدفع كاملاً',
        });
        enrolled += 1;
      } else if (n === 1) {
        // An overdue follow-up, so "مهامي اليوم" has something urgent in it.
        await call(agent.accessToken, 'PATCH', `/leads/${lead._id}/status`, {
          status: 'follow_up',
          nextFollowUpAt: yesterday,
          note: 'طلب معاودة الاتصال',
        });
        overdue += 1;
      } else if (n === 2) {
        await call(agent.accessToken, 'PATCH', `/leads/${lead._id}/status`, {
          status: 'follow_up',
          nextFollowUpAt: tomorrow,
        });
      } else if (n === 3) {
        await call(agent.accessToken, 'PATCH', `/leads/${lead._id}/status`, {
          status: 'not_interested',
          lostReason: 'السعر أعلى من الميزانية',
        });
      }
    }
  }
  logger.info(`  ${contacted} contacted, ${enrolled} enrolled, ${overdue} overdue follow-up(s)`);

  // ---- 3. An unassigned queue for a leader to drain ------------------------
  const leader = await login('khalid.leader@tamkeentraining.com');
  for (let n = 0; n < 3; n += 1) {
    await call(leader.accessToken, 'POST', '/leads', {
      fullName: pick(AR_NAMES, 14 + n),
      phone: nextPhone(),
      branch: ajman._id,
      source: 'phone',
      autoAssign: false,
      note: 'استفسار هاتفي، بانتظار التوزيع',
    });
  }
  logger.info('  3 unassigned leads waiting in the queue');

  // ---- 4. An imported batch, so the source filter has one ------------------
  const importRows = Array.from({ length: 6 }, (_, n) => ({
    'الاسم': `${pick(AR_NAMES, n + 6)} (عميل سابق)`,
    'رقم الهاتف': nextPhone(),
    'البريد الإلكتروني': `past${n}@example.com`,
    'الدورة': pick(COURSES, n),
    'ملاحظات': 'من قائمة العملاء السابقين',
  }));
  const imported = await call(leader.accessToken, 'POST', '/leads/import', { rows: importRows });
  logger.info(`  imported ${imported.data.summary.created} past customers`);

  // ---- Summary -------------------------------------------------------------
  const overview = (await call(admin.accessToken, 'GET', '/dashboard/overview')).data.overview;
  const platforms = (await call(admin.accessToken, 'GET', '/dashboard/sources')).data.byPlatform;

  logger.info('');
  logger.info('Demo data ready:');
  logger.info(`  total leads      ${overview.totalLeads}`);
  logger.info(`  enrolled         ${overview.enrolled}  (${overview.conversionRate}% conversion)`);
  logger.info(`  revenue          ${overview.revenue} AED`);
  logger.info(`  unassigned       ${overview.unassigned}`);
  logger.info(`  overdue          ${overview.overdueFollowUps}`);
  logger.info(`  by network       ${platforms.map((p) => `${p._id}=${p.leads}`).join('  ')}`);
}

main().catch((err) => {
  logger.error(String(err.message ?? err));
  logger.error('Is the API running? Start it with `npm run dev` in another terminal first.');
  process.exit(1);
});
