/**
 * Minimal structured logger. Deliberately dependency-free so it can be used
 * from config loading, before anything else is wired up.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const active = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);

function emit(level, args) {
  if (LEVELS[level] > active) return;
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${level.toUpperCase().padEnd(5)}`;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line, ...args);
}

const logger = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
};

export default logger;
