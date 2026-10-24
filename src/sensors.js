'use strict';

const { ensureNamedService } = require('./services');
const { finiteNumber, pairedSensor, contactState } = require('./mapping');

const LOW_BATTERY_PERCENT = 20;
const WINDOW_SLOTS = [
  { key: 'window', label: 'Window 1' },
  { key: 'window_1', label: 'Window 2' },
  { key: 'window_2', label: 'Window 3' },
  { key: 'window_3', label: 'Window 4' },
];

/**
 * Read-only sensor services fed by the module: outdoor temperature, the
 * paired wireless thermometer and paired window sensors. A service exists only
 * while it is enabled in the config and the device reports data for it.
 */
class SensorServices {
  constructor({ accessory, hap, config, log, name, onServicesChanged }) {
    this.accessory = accessory;
    this.hap = hap;
    this.config = config;
    this.log = log;
    this.name = name;
    this.onServicesChanged = onServicesChanged;
    this.warnedContactValues = new Set();
  }

  apply(state) {
    const { Service } = this.hap;
    const hp = state.heatpump || {};
    const sensors = state.sensor || {};
    let changed = false;
    const sync = (type, subtype, label, wanted) => {
      const existing = this.accessory.getServiceById(type, subtype);
      if (!wanted) {
        if (existing) {
          this.accessory.removeService(existing);
          changed = true;
        }
        return null;
      }
      if (!existing) {
        changed = true;
      }
      return ensureNamedService(this.accessory, this.hap, type, label, subtype);
    };

    const outdoor = finiteNumber((hp.op || {}).outdoor);
    const outdoorSvc = sync(
      Service.TemperatureSensor,
      'outdoor',
      'Outdoor',
      this.config.exposeOutdoorTemperature !== false && outdoor !== undefined
    );
    if (outdoorSvc) {
      this.applyOutdoor(outdoorSvc, outdoor);
    }

    const thermometer =
      this.config.exposeThermometer !== false ? pairedSensor(sensors.thermometer) : undefined;
    const humiditySvc = sync(Service.HumiditySensor, 'humidity', 'Humidity', !!thermometer);
    const batterySvc = sync(Service.Battery, 'thermometer_battery', 'Thermometer Battery', !!thermometer);
    if (thermometer) {
      this.applyThermometer(humiditySvc, batterySvc, thermometer);
    }

    for (const { key, label } of WINDOW_SLOTS) {
      const window =
        this.config.exposeWindowSensors !== false ? pairedSensor(sensors[key]) : undefined;
      const svc = sync(Service.ContactSensor, key, label, !!window);
      if (window) {
        this.applyWindow(svc, key, window);
      }
    }

    if (changed) {
      this.onServicesChanged();
    }
  }

  applyOutdoor(svc, outdoor) {
    const { Characteristic } = this.hap;
    svc
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 });
    svc.updateCharacteristic(Characteristic.CurrentTemperature, outdoor);
  }

  applyThermometer(humiditySvc, batterySvc, thermometer) {
    const { Characteristic } = this.hap;
    const humidity = finiteNumber(thermometer.hact);
    if (humidity !== undefined) {
      humiditySvc.updateCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        Math.min(100, Math.max(0, humidity))
      );
    }
    const battery = finiteNumber(thermometer.batt);
    batterySvc.updateCharacteristic(
      Characteristic.ChargingState,
      Characteristic.ChargingState.NOT_CHARGEABLE
    );
    if (battery !== undefined) {
      const level = Math.min(100, Math.max(0, Math.round(battery)));
      const low = this.lowBattery(level);
      batterySvc.updateCharacteristic(Characteristic.BatteryLevel, level);
      batterySvc.updateCharacteristic(Characteristic.StatusLowBattery, low);
      humiditySvc.updateCharacteristic(Characteristic.StatusLowBattery, low);
    }
  }

  applyWindow(svc, key, window) {
    const { Characteristic } = this.hap;
    const contact = contactState(window.state);
    if (contact) {
      svc.updateCharacteristic(
        Characteristic.ContactSensorState,
        contact === 'open'
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED
      );
    } else {
      // The state format is unverified, so surface unknown values once
      // instead of guessing open or closed.
      const marker = `${key}:${window.state}`;
      if (!this.warnedContactValues.has(marker)) {
        this.warnedContactValues.add(marker);
        this.log.warn(
          `[${this.name}] Unrecognised window sensor state ${JSON.stringify(window.state)} for ${key}; please report it.`
        );
      }
    }
    const battery = finiteNumber(window.batt);
    if (battery !== undefined) {
      svc.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery(battery));
    }
  }

  lowBattery(percent) {
    const { StatusLowBattery } = this.hap.Characteristic;
    return percent <= LOW_BATTERY_PERCENT
      ? StatusLowBattery.BATTERY_LEVEL_LOW
      : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }
}

module.exports = { SensorServices };
