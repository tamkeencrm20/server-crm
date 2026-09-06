/**
 * Creates (or repairs) a single administrator account.
 *
 * Unlike `npm run seed`, this touches nothing else: no branches, no courses,
 * no demo team, no shared password. It is the one thing you want to run
 * against a live database.
 *
 *   npm run seed:admin -- --email you@tamkeentraining.com --name "Your Name"
 *
 * The password comes from the ADMIN_PASSWORD environment variable so it never
 * lands in your shell history, in the process list, or in a deploy log:
 *
 *   ADMIN_PASSWORD='...' npm run seed:admin -- --email you@tamkeentraining.com
 *
 * If the account already exists the script resets its password, restores the
 * admin role, and re-enables it — which is also how you recover from a
 * forgotten production password. Existing refresh tokens are invalidated, so
 * any other session signed in as this account is logged out.
 */
import mongoose from 'mongoose';
import env from '../src/config/env.js';
import logger from '../src/utils/logger.js';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import User from '../src/models/User.js';
import { ROLES } from '../src/config/constants.js';

const MIN_PASSWORD_LENGTH = 12;

/** Read `--flag value` pairs off argv. */
function arg(flag) {
  const i = process.argv.indexOf(`--${flag}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function fail(message, hint) {
  logger.error(message);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

/**
 * Refuse passwords that would not survive a credential-stuffing attempt.
 * An admin account sees every lead in every branch, so this is not the place
 * to be lenient.
 */
function checkPasswordStrength(password) {
  const problems = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/\d/.test(password)) problems.push('a digit');

  // The passwords that ship in the repo must never reach a live database.
  const known = ['Tamkeen@2026', 'Password123', 'password', 'admin123'];
  if (known.some((k) => k.toLowerCase() === password.toLowerCase())) {
    return ['not be one of the demo passwords published in this repository'];
  }

  return problems;
}

async function main() {
  const email = (arg('email') ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const name = (arg('name') ?? process.env.ADMIN_NAME ?? 'Administrator').trim();
  const password = process.env.ADMIN_PASSWORD ?? '';

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    fail(
      'A valid --email is required',
      "Usage:\n  ADMIN_PASSWORD='your-password' npm run seed:admin -- --email you@tamkeentraining.com --name 'Your Name'",
    );
  }

  if (!password) {
    fail(
      'ADMIN_PASSWORD is not set',
      "Pass it as an environment variable so it stays out of your shell history:\n  ADMIN_PASSWORD='your-password' npm run seed:admin -- --email " + email,
    );
  }

  const problems = checkPasswordStrength(password);
  if (problems.length > 0) {
    fail(`ADMIN_PASSWORD is too weak — it must have ${problems.join(', ')}`);
  }

  await connectDatabase();

  // Say which database this is about to touch; on a live system that matters
  // more than anything else the script prints.
  const { host, name: dbName } = mongoose.connection;
  logger.info(`Target database: ${dbName} on ${host}`);

  let user = await User.findOne({ email });
  const existed = Boolean(user);

  if (user) {
    logger.warn(`${email} already exists (role: ${user.role}) — resetting the password and restoring admin access`);
    user.role = ROLES.ADMIN;
    user.isActive = true;
    user.branch = undefined; // admins are not scoped to a branch
    if (name && name !== 'Administrator') user.name = name;
  } else {
    user = new User({ name, email, role: ROLES.ADMIN, isActive: true });
  }

  // setPassword bumps tokenVersion, which invalidates every issued refresh
  // token for this account.
  await user.setPassword(password);
  await user.save();

  logger.info(`${existed ? 'Updated' : 'Created'} administrator: ${user.name} <${user.email}>`);
  console.log('\nSign in with the password you supplied. It was never printed or logged.\n');

  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.error('Failed to create the administrator', err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});

export { checkPasswordStrength };
