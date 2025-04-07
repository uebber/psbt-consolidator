// logger.js
import util from 'util';

const LOG_LEVELS = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

// Keep default level initialization - will be overridden by setLogLevel if called
let currentLevel = LOG_LEVELS.info;

// Internal log function: handles formatting and conditional output
function log(level, ...args) {
  // Check if the message's level meets the current threshold
  if (LOG_LEVELS[level] >= currentLevel) {
    const timestamp = new Date().toISOString();
    // Deep inspect objects for better logging clarity
    const formattedArgs = args.map(arg =>
      typeof arg === 'object' && arg !== null
        ? util.inspect(arg, { depth: null, colors: true })
        : arg
    );
    // Output the log message to the console
    console.log(`[${timestamp}] [${level.toUpperCase()}]`, ...formattedArgs);
  }
}

// Function to change the current logging level
function setLogLevel(level) {
  const normalizedLevel = level?.toLowerCase();
  if (normalizedLevel in LOG_LEVELS) {
    const previousLevelName = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLevel);
    currentLevel = LOG_LEVELS[normalizedLevel];
    // Log the level change itself using the internal 'log' function
    // This ensures the message respects the *new* level if it's less verbose
    // Or always shows if the new level is 'info' or more verbose.
    // We specifically use 'info' level for this message for visibility.
    if (LOG_LEVELS['info'] >= currentLevel || LOG_LEVELS['info'] >= LOG_LEVELS[previousLevelName]) {
         log('info', `Log level set to: ${normalizedLevel}`);
    }
  } else {
    // Log a warning if the provided level was invalid
    log('warn', `Invalid log level provided: "${level}". Defaulting to 'info'.`);
    currentLevel = LOG_LEVELS.info; // Set to default 'info' level
  }
}

// Export the public logger interface
const logger = {
  setLogLevel, // Expose the function to set the level
  // Define logging methods for each level, calling the internal 'log' function
  trace: (...args) => log('trace', ...args),
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
};

export default logger;
