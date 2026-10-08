const base = require('./capacitor.config.json');
const { stagedOrigin } = require('./scripts/native-origin.cjs');

// Capacitor loads this module before the structural JSON config. Plain CJS
// supports its require() loader without a TypeScript or ESM loader dependency.
module.exports = {
  ...base,
  server: {
    url: stagedOrigin(process.cwd()),
    cleartext: false,
    errorPath: 'native-unavailable.html',
  },
};
