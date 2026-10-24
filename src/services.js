'use strict';

/**
 * Get or add a secondary service with a short display name. The service is
 * already grouped under the accessory, so the label is used on its own —
 * prefixing the (long) accessory name gets truncated in the Home app.
 */
function ensureNamedService(accessory, hap, type, label, subtype) {
  const { Characteristic } = hap;
  const svc = accessory.getServiceById(type, subtype) || accessory.addService(type, label, subtype);
  svc.setCharacteristic(Characteristic.Name, label);
  // ConfiguredName is what the Home app actually shows for extra services on
  // a single accessory; without it every tile inherits the accessory name.
  // Register it as optional first so HAP doesn't warn about an unknown
  // characteristic.
  if (Characteristic.ConfiguredName) {
    if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
      svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    svc.setCharacteristic(Characteristic.ConfiguredName, label);
  }
  return svc;
}

module.exports = { ensureNamedService };
