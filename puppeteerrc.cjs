const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Store Chrome in the project directory so Railway caches it
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
