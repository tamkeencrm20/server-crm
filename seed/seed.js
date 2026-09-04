/**
 * Seeds a working Tamkeen CRM: the two live branches, a realistic course list
 * taken from tamkeentraining.com, and one admin / two team leaders / five
 * agents so round-robin distribution can be exercised straight away.
 *
 *   npm run seed          add anything missing, leave existing data alone
 *   npm run seed:reset    wipe the collections first
 */
import mongoose from 'mongoose';
import env from '../src/config/env.js';
import logger from '../src/utils/logger.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Branch from '../src/models/Branch.js';
import Course from '../src/models/Course.js';
import User from '../src/models/User.js';
import Lead from '../src/models/Lead.js';
import Activity from '../src/models/Activity.js';
import Assignment from '../src/models/Assignment.js';
import Notification from '../src/models/Notification.js';
import DistributionCursor from '../src/models/DistributionCursor.js';
import RefreshToken from '../src/models/RefreshToken.js';
import { ROLES, DISTRIBUTION_STRATEGY } from '../src/config/constants.js';

const RESET = process.argv.includes('--reset');

// Everyone gets the same starting password; the seed prints it once.
const DEFAULT_PASSWORD = process.env.SEED_PASSWORD ?? 'Tamkeen@2026';

const BRANCHES = [
  {
    code: 'ajman',
    name: { ar: 'فرع عجمان', en: 'Ajman Branch' },
    city: { ar: 'عجمان', en: 'Ajman' },
    phone: '+971 6 000 0000',
    distributionStrategy: DISTRIBUTION_STRATEGY.ROUND_ROBIN,
  },
  {
    code: 'dubai',
    name: { ar: 'فرع دبي', en: 'Dubai Branch' },
    city: { ar: 'دبي', en: 'Dubai' },
    phone: '+971 4 000 0000',
    distributionStrategy: DISTRIBUTION_STRATEGY.ROUND_ROBIN,
  },
];

const COURSES = [
  { code: 'KPI', name: { ar: 'التدريب في مؤشرات قياس الأداء', en: 'Key Performance Indicators (KPIs)' }, price: 3500, durationHours: 30 },
  { code: 'ENTR', name: { ar: 'التدريب في ريادة الأعمال والابتكار', en: 'Entrepreneurship & Innovation' }, price: 4200, durationHours: 40 },
  { code: 'HOSPQ', name: { ar: 'التدريب في جودة إدارة المستشفيات', en: 'Hospital Management Quality' }, price: 5500, durationHours: 45 },
  { code: 'PMP', name: { ar: 'إدارة المشاريع الاحترافية', en: 'Project Management Professional' }, price: 6000, durationHours: 60 },
  { code: 'HR', name: { ar: 'إدارة الموارد البشرية', en: 'Human Resources Management' }, price: 3800, durationHours: 35 },
  { code: 'OSH', name: { ar: 'الصحة والسلامة المهنية', en: 'Occupational Safety & Health' }, price: 3200, durationHours: 30 },
];

const TEAM = [
  { name: 'Admin Tamkeen', email: 'admin@tamkeentraining.com', role: ROLES.ADMIN, branch: null },

  { name: 'Khalid Al Marzooqi', email: 'khalid.leader@tamkeentraining.com', role: ROLES.TEAM_LEADER, branch: 'ajman' },
  { name: 'Sara Al Hosani', email: 'sara.leader@tamkeentraining.com', role: ROLES.TEAM_LEADER, branch: 'dubai' },

  { name: 'Ahmed Mansour', email: 'ahmed.agent@tamkeentraining.com', role: ROLES.AGENT, branch: 'ajman' },
  { name: 'Fatima Al Zaabi', email: 'fatima.agent@tamkeentraining.com', role: ROLES.AGENT, branch: 'ajman' },
  { name: 'Omar Haddad', email: 'omar.agent@tamkeentraining.com', role: ROLES.AGENT, branch: 'ajman' },

  { name: 'Layla Ibrahim', email: 'layla.agent@tamkeentraining.com', role: ROLES.AGENT, branch: 'dubai' },
  { name: 'Yousef Kareem', email: 'yousef.agent@tamkeentraining.com', role: ROLES.AGENT, branch: 'dubai' },
];

async function reset() {
  logger.warn('--reset given: clearing all CRM collections');
  await Promise.all([
    Lead.deleteMany({}),
    Activity.deleteMany({}),
    Assignment.deleteMany({}),
    Notification.deleteMany({}),
    DistributionCursor.deleteMany({}),
    RefreshToken.deleteMany({}),
    User.deleteMany({}),
    Course.deleteMany({}),
    Branch.deleteMany({}),
  ]);
}

async function seedBranches() {
  const byCode = new Map();
  for (const data of BRANCHES) {
    // eslint-disable-next-line no-await-in-loop
    const branch = await Branch.findOneAndUpdate(
      { code: data.code },
      { $setOnInsert: data },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    byCode.set(data.code, branch);
  }
  logger.info(`Branches ready: ${[...byCode.keys()].join(', ')}`);
  return byCode;
}

async function seedCourses(branchesByCode) {
  const all = [...branchesByCode.values()].map((b) => b._id);
  for (const data of COURSES) {
    // eslint-disable-next-line no-await-in-loop
    await Course.findOneAndUpdate(
      { code: data.code },
      { $setOnInsert: { ...data, branches: all } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  logger.info(`Courses ready: ${COURSES.length}`);
}

async function seedUsers(branchesByCode) {
  const created = [];

  for (const spec of TEAM) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await User.findOne({ email: spec.email });
    if (existing) {
      created.push({ ...spec, status: 'exists' });
      continue;
    }

    const user = new User({
      name: spec.name,
      email: spec.email,
      role: spec.role,
      branch: spec.branch ? branchesByCode.get(spec.branch)._id : undefined,
      locale: 'ar',
    });
    // eslint-disable-next-line no-await-in-loop
    await user.setPassword(DEFAULT_PASSWORD);
    // eslint-disable-next-line no-await-in-loop
    await user.save();
    created.push({ ...spec, status: 'created' });
  }

  const fresh = created.filter((c) => c.status === 'created').length;
  logger.info(`Users ready: ${fresh} created, ${created.length - fresh} already present`);
  return created;
}

async function main() {
  await connectDatabase();
  logger.info(`Seeding ${env.MONGO_URI}`);

  if (RESET) await reset();

  const branches = await seedBranches();
  await seedCourses(branches);
  const team = await seedUsers(branches);

  const fresh = team.filter((t) => t.status === 'created');
  if (fresh.length > 0) {
    logger.info('');
    logger.info('Sign-in accounts (all share the same password):');
    logger.info(`  password: ${DEFAULT_PASSWORD}`);
    for (const t of fresh) {
      logger.info(`  ${t.role.padEnd(12)} ${t.email}${t.branch ? `  [${t.branch}]` : ''}`);
    }
    logger.info('');
    logger.info('Change these before the system goes anywhere near production.');
  }

  await disconnectDatabase();
  await mongoose.disconnect().catch(() => {});
}

main().catch(async (err) => {
  logger.error('Seed failed', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
