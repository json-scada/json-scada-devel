/*
 * {json:scada} - Node-RED settings template.
 *
 * Copy to conf/node-red-settings.js and pass to Node-RED with:
 *   node .../node-red/red.js -s /path/to/conf/node-red-settings.js
 *
 * This binds Node-RED to localhost and serves the editor under /nodered/ so it can be
 * reverse-proxied by the JSON-SCADA nginx. Set adminAuth before exposing it anywhere.
 */

const path = require('path')

// userDir holds flows, credentials and installed nodes. On Windows the installer
// points this at C:\json-scada\conf\node-red; on Linux at conf/node-red.
const userDir =
  process.env.JS_NODERED_USERDIR ||
  path.join(process.env.HOME || process.env.USERPROFILE || '.', '.node-red')

module.exports = {
  uiPort: parseInt(process.env.JS_NODERED_PORT || '1880', 10),
  uiHost: process.env.JS_NODERED_HOST || '127.0.0.1',

  userDir: userDir,
  flowFile: 'flows.json',

  // Editor is served under this path so nginx can proxy /nodered/ (with WS upgrade).
  httpAdminRoot: '/nodered/',
  httpNodeRoot: '/nodered-api/',

  // Encrypts stored credentials. Generated once at install; change and keep secret.
  credentialSecret:
    process.env.JS_NODERED_CRED_SECRET || 'CHANGE_ME_json_scada_nodered',

  // ---- SECURITY: enable adminAuth before any non-localhost exposure ----
  // Generate a password hash with:
  //   node .../node-red/node_modules/.bin/node-red-admin hash-pw
  // then uncomment:
  // adminAuth: {
  //   type: 'credentials',
  //   users: [{ username: 'admin', password: '<hash>', permissions: '*' }],
  // },

  logging: {
    console: { level: 'info', metrics: false, audit: false },
  },

  functionGlobalContext: {},
  exportGlobalContextKeys: false,

  editorTheme: {
    projects: { enabled: false },
    page: { title: 'JSON-SCADA Node-RED' },
  },

  httpServerOptions: {
    // Trust the proxy server's IP address
    'trust proxy': '127.0.0.1',
    'x-powered-by': false,
  },
}
