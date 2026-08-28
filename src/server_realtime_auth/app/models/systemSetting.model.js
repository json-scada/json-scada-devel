const mongoose = require('mongoose')

// Singleton collection holding runtime-changeable global toggles. A single document
// with the fixed key 'global' is used; fields are optional and default in code.
const SystemSetting = mongoose.model(
  'SystemSetting',
  new mongoose.Schema({
    key: { type: String, default: 'global', unique: true },
    autoManageServices: { type: Boolean, default: true },
    autoRestartOnConnectionChange: { type: Boolean, default: true },
  }),
  'systemSettings'
)

module.exports = SystemSetting
