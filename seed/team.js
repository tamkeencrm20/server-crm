/**
 * Creates the real Tamkeen team: three administrators, a team leader and a
 * media buyer per branch, and a sales agent per branch.
 *
 *   TEAM_PASSWORD='...' npm run seed:team
 *   TEAM_PASSWORD='...' npm run seed:team -- --dry-run
 *   TEAM_PASSWORD='...' npm run seed:team -- --prune     leave only this team active
 *
 * Why a script rather than pasting documents into Atlas:
 *
 *   - A password has to be stored as a bcrypt hash, never as text.
 *   - Every account except an admin must point at a real branch _id, which
 *     differs between databases; this looks each one up by code.
 *   - A document inserted straight into Atlas skips the schema's defaults, so
 *     counters, availability and tokenVersion silently come out undefined and
 *     the account behaves oddly later.
 *
 * Re-running is safe: an existing account keeps its password and is only
 * corrected if its name, role or branch drifted.
 *
 * `--prune` deactivates every other account so the live system holds this team
 * and nobody else. It deactivates rather than deletes: a deleted user takes the
 * meaning of their leads with them — every lead they ever owned would point at
 * a missing record, and the assignment trail and activity timeline would lose
 * the name behind each entry. A deactivated account cannot sign in and is out
 * of the distribution rotation, which is the part that matters.
 */
import mongoose from 'mongoose';
import env from '../src/config/env.js';
import logger from '../src/utils/logger.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import Branch from '../src/models/Branch.js';
import User from '../src/models/User.js';
import { ROLES, DISTRIBUTION_STRATEGY } from '../src/config/constants.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');
const PASSWORD = process.env.TEAM_PASSWORD ?? '';
const DOMAIN = process.env.TEAM_DOMAIN ?? 'tamkeentraining.com';

/** The two branches these people belong to, created only if missing. */
const BRANCHES = [
  {
    code: 'ajman',
    name: { ar: 'فرع عجمان', en: 'Ajman Branch' },
    city: { ar: 'عجمان', en: 'Ajman' },
    distributionStrategy: DISTRIBUTION_STRATEGY.ROUND_ROBIN,
  },
  {
    code: 'dubai',
    name: { ar: 'فرع دبي', en: 'Dubai Branch' },
    city: { ar: 'دبي', en: 'Dubai' },
    distributionStrategy: DISTRIBUTION_STRATEGY.ROUND_ROBIN,
  },
];

/**
 * The title that precedes each person's name on screen. The role already shows
 * as a coloured badge next to the name, but the badge is absent in the tighter
 * places — the owner column on a lead row, the assignment picker — so carrying
 * it in the name itself makes the role readable everywhere.
 */
const TITLES = Object.freeze({
  [ROLES.ADMIN]: 'Mr.',
  [ROLES.TEAM_LEADER]: 'Team Leader',
  [ROLES.MEDIA_BUYER]: 'Media Buyer',
  [ROLES.AGENT]: 'Sales Agent',
});

/**
 * `local` becomes the part of the address before the @, and `name` is the bare
 * personal name — the title above is prefixed when the account is written.
 *
 * There are two people called Ahmed, so the administrator holds the plain
 * `ahmed` address and the media buyer is qualified by role. Change either in
 * this list and re-run if you would rather they were the other way round.
 */
const TEAM = [
  { local: 'ali', name: 'علي', role: ROLES.ADMIN, branch: null },
  { local: 'mahmoud', name: 'محمود', role: ROLES.ADMIN, branch: null },
  { local: 'ahmed', name: 'أحمد', role: ROLES.ADMIN, branch: null },

  { local: 'islam', name: 'إسلام', role: ROLES.TEAM_LEADER, branch: 'dubai' },
  { local: 'waad', name: 'وعد', role: ROLES.TEAM_LEADER, branch: 'ajman' },

  { local: 'mariam', name: 'مريم', role: ROLES.MEDIA_BUYER, branch: 'ajman' },
  { local: 'ahmed.media', name: 'أحمد', role: ROLES.MEDIA_BUYER, branch: 'dubai' },

  { local: 'ragab', name: 'رجب', role: ROLES.AGENT, branch: 'ajman' },
  { local: 'sherif', name: 'شريف', role: ROLES.AGENT, branch: 'dubai' },
];

/** The same rule the admin-creation script applies. */
function passwordProblems(pw) {
  const problems = [];
  if (pw.length < 12) problems.push('at least 12 characters');
  if (!/[a-z]/.test(pw)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) problems.push('an uppercase letter');
  if (!/\d/.test(pw)) problems.push('a digit');

  const published = ['Tamkeen@2026', 'Password123', 'password', 'admin123'];
  if (published.some((p) => p.toLowerCase() === pw.toLowerCase())) {
    return ['not be one of the demo passwords published in this repository'];
  }
  return problems;
}

async function main() {
  if (!PASSWORD) {
    logger.error('TEAM_PASSWORD is not set');
    console.error(
      "\nPass it as an environment variable so it stays out of your shell history:\n" +
        "  TEAM_PASSWORD='your-password' npm run seed:team\n",
    );
    process.exit(1);
  }

  const problems = passwordProblems(PASSWORD);
  if (problems.length > 0) {
    logger.error(`TEAM_PASSWORD is too weak — it must have ${problems.join(', ')}`);
    process.exit(1);
  }

  await connectDatabase();
  const { host, name: dbName } = mongoose.connection;
  logger.info(`Target database: ${dbName} on ${host}`);
  if (DRY_RUN) logger.warn('Dry run — nothing will be written');

  // ---- branches -----------------------------------------------------------
  const byCode = new Map();
  for (const spec of BRANCHES) {
    let branch = await Branch.findOne({ code: spec.code });
    if (branch) {
      logger.info(`branch ${spec.code.padEnd(6)} already exists`);
    } else if (DRY_RUN) {
      logger.info(`branch ${spec.code.padEnd(6)} would be created`);
    } else {
      branch = await Branch.create(spec);
      logger.info(`branch ${spec.code.padEnd(6)} created`);
    }
    if (branch) byCode.set(spec.code, branch._id);
  }

  // ---- people -------------------------------------------------------------
  const created = [];
  const updated = [];
  const kept = [];

  for (const person of TEAM) {
    const email = `${person.local}@${DOMAIN}`.toLowerCase();
    const displayName = `${TITLES[person.role]} ${person.name}`.trim();
    const branchId = person.branch ? byCode.get(person.branch) : undefined;

    if (person.branch && !branchId && !DRY_RUN) {
      logger.error(`${email}: branch ${person.branch} is missing, skipping`);
      continue;
    }

    const existing = await User.findOne({ email });

    if (existing) {
      // Leave the password alone — they may already have changed it.
      const roleDrifted = existing.role !== person.role;
      const branchDrifted = String(existing.branch ?? '') !== String(branchId ?? '');
      const nameDrifted = existing.name !== displayName;

      if (roleDrifted || branchDrifted || nameDrifted) {
        if (!DRY_RUN) {
          existing.name = displayName;
          existing.role = person.role;
          existing.branch = branchId;
          existing.isActive = true;
          await existing.save();
        }
        updated.push({ ...person, email });
      } else {
        kept.push({ ...person, email });
      }
      continue;
    }

    if (!DRY_RUN) {
      const user = new User({
        name: displayName,
        email,
        role: person.role,
        branch: branchId,
        isActive: true,
        // Only agents are in the distribution rotation, but the field is
        // harmless on the others and keeps the documents uniform.
        isAvailable: true,
        dailyLeadCap: 0,
        locale: 'ar',
      });
      await user.setPassword(PASSWORD);
      await user.save();
    }
    created.push({ ...person, email });
  }

  // ---- report -------------------------------------------------------------
  const line = (p) =>
    `  ${`${TITLES[p.role]} ${p.name}`.padEnd(22)} ${p.email.padEnd(34)} ${p.branch ?? '—'}`;

  logger.info('');
  if (created.length) {
    logger.info(`${DRY_RUN ? 'Would create' : 'Created'} ${created.length}:`);
    created.forEach((p) => logger.info(line(p)));
  }
  if (updated.length) {
    logger.info(`${DRY_RUN ? 'Would correct' : 'Corrected'} ${updated.length} (name, role or branch had drifted):`);
    updated.forEach((p) => logger.info(line(p)));
  }
  if (kept.length) {
    logger.info(`Left untouched ${kept.length} (already correct, password kept):`);
    kept.forEach((p) => logger.info(line(p)));
  }

  // ---- prune -------------------------------------------------------------
  if (PRUNE) {
    const keep = TEAM.map((p) => `${p.local}@${DOMAIN}`.toLowerCase());
    const others = await User.find({ email: { $nin: keep }, isActive: true }).select('name email role');

    if (others.length === 0) {
      logger.info('');
      logger.info('Nothing to prune — this team is already the only active account set.');
    } else {
      // Never strand the system without a way in.
      const survivingAdmins = TEAM.filter((p) => p.role === ROLES.ADMIN).length;
      if (survivingAdmins === 0) {
        logger.error('Refusing to prune: this team contains no administrator, which would lock everyone out');
        await disconnectDatabase();
        process.exit(1);
      }

      logger.info('');
      logger.info(`${DRY_RUN ? 'Would deactivate' : 'Deactivated'} ${others.length} other account(s):`);
      others.forEach((u) => logger.info(`  ${String(u.role).padEnd(12)} ${u.email}`));

      if (!DRY_RUN) {
        await User.updateMany(
          { email: { $nin: keep } },
          { $set: { isActive: false, isAvailable: false } },
        );
      }
      logger.info('They keep their records, so existing leads still show who handled them.');
    }
  }

  logger.info('');
  logger.info('Everyone signs in with the password you supplied. It was never printed or logged.');
  logger.info('Tell them to change it from Settings on first sign-in.');

  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.error('Failed to seed the team', err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
