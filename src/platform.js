'use strict';

const { MhiAccessory } = require('./accessory');

const PLUGIN_NAME = 'homebridge-mitsubishi-hi-wifi-module';
const PLATFORM_NAME = 'MitsubishiHIWiFi';

/**
 * Dynamic platform. Each configured device becomes one HomeKit accessory
 * (a HeaterCooler, optionally with a few extra Switch services).
 */
class MhiPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // Restored cached accessories, keyed by UUID.
    this.accessories = new Map();

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  /** Called by Homebridge for each cached accessory at startup. */
  configureAccessory(accessory) {
    this.log.debug(`Loading cached accessory: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];

    if (devices.length === 0) {
      this.log.warn(
        'No devices configured. Add at least one device (with a "host") in the plugin settings.'
      );
    }

    const activeUuids = new Set();

    for (const deviceConfig of devices) {
      if (!deviceConfig || !deviceConfig.host) {
        this.log.error('Skipping a device entry without a "host".');
        continue;
      }

      const name = deviceConfig.name || 'Mitsubishi AC';
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${deviceConfig.host}`);
      activeUuids.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (accessory) {
        this.log.info(`Restoring accessory from cache: ${name} (${deviceConfig.host})`);
        accessory.context.device = deviceConfig;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info(`Adding new accessory: ${name} (${deviceConfig.host})`);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.device = deviceConfig;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      // eslint-disable-next-line no-new
      new MhiAccessory(this, accessory, deviceConfig);
    }

    // Remove accessories that are no longer in the config.
    for (const [uuid, accessory] of this.accessories) {
      if (!activeUuids.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }
}

module.exports = { MhiPlatform, MhiAccessory, PLUGIN_NAME, PLATFORM_NAME };
