'use strict';

const { MhiDevice } = require('./device');

const DEFAULT_POLL_INTERVAL = 10; // seconds
const DEFAULT_MIN_TEMP = 16;
const DEFAULT_MAX_TEMP = 31;
const TEMP_STEP = 0.5;

// Fan speeds 1..4 mapped onto a 0-100 RotationSpeed slider (step 25).
const FAN_SPEEDS = ['1', '2', '3', '4'];

/**
 * Wires a single MHI air conditioner to a HomeKit HeaterCooler accessory.
 */
class MhiAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;
    this.log = platform.log;
    this.Service = platform.Service;
    this.Characteristic = platform.Characteristic;

    this.name = config.name || 'Mitsubishi AC';
    this.pollInterval = (config.pollInterval || DEFAULT_POLL_INTERVAL) * 1000;

    this.device = new MhiDevice(config.host, { log: this.log });

    // Last known full state from the device.
    this.state = null;
    // Temperature limits, refined once we have real state.
    this.minTemp = DEFAULT_MIN_TEMP;
    this.maxTemp = DEFAULT_MAX_TEMP;
    // Remembers the last heat/cool/auto mode so the Dry/Fan switches can revert.
    this.lastClimateMode = 'cool';

    this._setTimers = new Map();

    this.setupServices();
    this.startPolling();
  }

  // ---------------------------------------------------------------------------
  // Service setup
  // ---------------------------------------------------------------------------

  setupServices() {
    const { Service, Characteristic } = this;

    // Accessory information.
    this.infoService =
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);
    this.infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Mitsubishi Heavy Industries')
      .setCharacteristic(Characteristic.Model, 'MHI_CNS_ATA_WIFI')
      .setCharacteristic(Characteristic.SerialNumber, this.config.host);

    // Primary HeaterCooler service.
    this.hc =
      this.accessory.getService(Service.HeaterCooler) ||
      this.accessory.addService(Service.HeaterCooler, this.name);
    this.hc.setCharacteristic(Characteristic.Name, this.name);

    this.hc
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((v) => this.setActive(v));

    this.hc
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());

    this.hc
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          Characteristic.TargetHeaterCoolerState.AUTO,
          Characteristic.TargetHeaterCoolerState.HEAT,
          Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(() => this.getTargetState())
      .onSet((v) => this.setTargetState(v));

    this.hc
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.getCurrentTemperature());

    const tempProps = { minValue: this.minTemp, maxValue: this.maxTemp, minStep: TEMP_STEP };
    this.hc
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps(tempProps)
      .onGet(() => this.getTargetTemperature())
      .onSet((v) => this.setTargetTemperature(v));
    this.hc
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps(tempProps)
      .onGet(() => this.getTargetTemperature())
      .onSet((v) => this.setTargetTemperature(v));

    // Fan speed (1..4). "auto" is handled by the optional Auto Fan switch.
    this.hc
      .getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
      .onGet(() => this.getRotationSpeed())
      .onSet((v) => this.setRotationSpeed(v));

    // Swing (3D auto airflow).
    this.hc
      .getCharacteristic(Characteristic.SwingMode)
      .onGet(() => this.getSwing())
      .onSet((v) => this.setSwing(v));

    // Optional extra switches.
    this.silentSwitch = this.configureSwitch(
      'Silent',
      this.config.exposeSilentMode !== false,
      () => this.boolFromOnOff(this.heat('silent_mode')),
      (v) => this.device.setParam('silent_mode', v ? 'on' : 'off')
    );

    this.fanAutoSwitch = this.configureSwitch(
      'Auto Fan',
      this.config.exposeFanAuto !== false,
      () => this.heat('fan') === 'auto',
      (v) => this.setFanAuto(v)
    );

    this.drySwitch = this.configureSwitch(
      'Dry',
      this.config.exposeDryMode === true,
      () => this.heat('mode') === 'dry' && this.heat('power') === 'on',
      (v) => this.setExclusiveMode('dry', v)
    );

    this.fanModeSwitch = this.configureSwitch(
      'Fan Only',
      this.config.exposeFanMode === true,
      () => this.heat('mode') === 'fan' && this.heat('power') === 'on',
      (v) => this.setExclusiveMode('fan', v)
    );
  }

  /**
   * Add or remove an optional Switch service depending on `enabled`.
   * @returns {object|null} the Service, or null when disabled
   */
  configureSwitch(label, enabled, getter, setter) {
    const { Service, Characteristic } = this;
    const subtype = label.toLowerCase().replace(/\s+/g, '_');
    // The switch is already grouped under the accessory, so use the short label
    // on its own — prefixing the (long) accessory name gets truncated in the
    // Home app ("Living Room A…").
    const displayName = label;
    const existing = this.accessory.getServiceById(Service.Switch, subtype);

    if (!enabled) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return null;
    }

    const svc = existing || this.accessory.addService(Service.Switch, displayName, subtype);
    svc.setCharacteristic(Characteristic.Name, displayName);
    // ConfiguredName is what the Home app actually shows for extra services on
    // a single accessory; without it every tile inherits the accessory name.
    // Register it as optional first so HAP doesn't warn about an unknown
    // characteristic on the Switch service.
    if (Characteristic.ConfiguredName) {
      if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
        svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      }
      svc.setCharacteristic(Characteristic.ConfiguredName, displayName);
    }
    svc
      .getCharacteristic(Characteristic.On)
      .onGet(() => {
        try {
          return this.state ? !!getter() : false;
        } catch (_e) {
          return false;
        }
      })
      .onSet(async (v) => {
        try {
          await setter(v);
          this.scheduleRefresh();
        } catch (e) {
          this.log.error(`[${this.name}] Failed to set ${label}: ${e.message}`);
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
          );
        }
      });
    return svc;
  }

  // ---------------------------------------------------------------------------
  // State helpers
  // ---------------------------------------------------------------------------

  /** Safe access to a heatpump field from the last polled state. */
  heat(field) {
    return this.state && this.state.heatpump ? this.state.heatpump[field] : undefined;
  }

  boolFromOnOff(v) {
    return v === 'on' || v === true;
  }

  // ---------------------------------------------------------------------------
  // HeaterCooler getters (return cached values from the last poll)
  // ---------------------------------------------------------------------------

  getActive() {
    const { Characteristic } = this;
    return this.heat('power') === 'on'
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  getCurrentTemperature() {
    const t = this.heat('actual_temperature');
    return typeof t === 'number' ? t : 20;
  }

  getTargetTemperature() {
    const t = this.heat('set_temperature');
    const val = typeof t === 'number' ? t : this.minTemp;
    return Math.min(this.maxTemp, Math.max(this.minTemp, val));
  }

  getTargetState() {
    const { Characteristic } = this;
    switch (this.heat('mode')) {
      case 'heat':
        return Characteristic.TargetHeaterCoolerState.HEAT;
      case 'cool':
        return Characteristic.TargetHeaterCoolerState.COOL;
      case 'auto':
      case 'dry':
      case 'fan':
      default:
        return Characteristic.TargetHeaterCoolerState.AUTO;
    }
  }

  getCurrentState() {
    const { Characteristic } = this;
    const S = Characteristic.CurrentHeaterCoolerState;
    if (this.heat('power') !== 'on') {
      return S.INACTIVE;
    }
    const mode = this.heat('mode');
    const actual = this.heat('actual_temperature');
    const target = this.heat('set_temperature');
    switch (mode) {
      case 'heat':
        return S.HEATING;
      case 'cool':
      case 'dry':
        return S.COOLING;
      case 'fan':
        return S.IDLE;
      case 'auto':
      default:
        if (typeof actual === 'number' && typeof target === 'number') {
          if (actual > target + 0.5) return S.COOLING;
          if (actual < target - 0.5) return S.HEATING;
        }
        return S.IDLE;
    }
  }

  getRotationSpeed() {
    const fan = this.heat('fan');
    const idx = FAN_SPEEDS.indexOf(String(fan));
    if (idx === -1) {
      // "auto" or unknown -> show full speed as a sane visual default.
      return 100;
    }
    return (idx + 1) * 25;
  }

  getSwing() {
    const { Characteristic } = this;
    return this.boolFromOnOff(this.heat('auto3d'))
      ? Characteristic.SwingMode.SWING_ENABLED
      : Characteristic.SwingMode.SWING_DISABLED;
  }

  // ---------------------------------------------------------------------------
  // HeaterCooler setters
  // ---------------------------------------------------------------------------

  async setActive(value) {
    const on = value === this.Characteristic.Active.ACTIVE;
    await this.command('power', on ? 'on' : 'off');
  }

  async setTargetState(value) {
    const { Characteristic } = this;
    let mode;
    switch (value) {
      case Characteristic.TargetHeaterCoolerState.HEAT:
        mode = 'heat';
        break;
      case Characteristic.TargetHeaterCoolerState.COOL:
        mode = 'cool';
        break;
      case Characteristic.TargetHeaterCoolerState.AUTO:
      default:
        mode = 'auto';
        break;
    }
    this.lastClimateMode = mode;
    await this.command('mode', mode);
  }

  setTargetTemperature(value) {
    // Round to the device's 0.5 step and debounce (slider drags fire rapidly).
    const rounded = Math.round(value * 2) / 2;
    this.debounce('set_temperature', () => this.command('set_temperature', rounded), 400);
  }

  async setRotationSpeed(value) {
    if (value <= 0) {
      // RotationSpeed 0 means "off" in HomeKit; power off the unit.
      await this.command('power', 'off');
      return;
    }
    const idx = Math.min(FAN_SPEEDS.length - 1, Math.max(0, Math.round(value / 25) - 1));
    this.debounce('fan', () => this.command('fan', FAN_SPEEDS[idx]), 400);
  }

  async setSwing(value) {
    const on = value === this.Characteristic.SwingMode.SWING_ENABLED;
    await this.command('auto3d', on ? 'on' : 'off');
  }

  // ---------------------------------------------------------------------------
  // Optional-switch setters
  // ---------------------------------------------------------------------------

  async setFanAuto(on) {
    if (on) {
      await this.device.setParam('fan', 'auto');
    } else {
      // Restore a concrete speed from the current slider position.
      const idx = Math.min(
        FAN_SPEEDS.length - 1,
        Math.max(0, Math.round(this.getRotationSpeed() / 25) - 1)
      );
      await this.device.setParam('fan', FAN_SPEEDS[idx]);
    }
  }

  async setExclusiveMode(mode, on) {
    if (on) {
      if (this.heat('power') !== 'on') {
        await this.device.setParam('power', 'on');
      }
      await this.device.setParam('mode', mode);
    } else {
      // Turning the special mode off reverts to the last heat/cool/auto mode.
      await this.device.setParam('mode', this.lastClimateMode || 'cool');
    }
  }

  // ---------------------------------------------------------------------------
  // Command + polling plumbing
  // ---------------------------------------------------------------------------

  /** Send a command, optimistically update the cache, then refresh soon. */
  async command(param, value) {
    try {
      this.log.debug(`[${this.name}] set ${param}=${value}`);
      await this.device.setParam(param, value);
      if (this.state && this.state.heatpump) {
        this.state.heatpump[param] = value;
      }
      this.scheduleRefresh();
    } catch (e) {
      this.log.error(`[${this.name}] Failed to set ${param}=${value}: ${e.message}`);
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
      );
    }
  }

  debounce(key, fn, ms) {
    if (this._setTimers.has(key)) {
      clearTimeout(this._setTimers.get(key));
    }
    this._setTimers.set(
      key,
      setTimeout(() => {
        this._setTimers.delete(key);
        Promise.resolve(fn()).catch((e) =>
          this.log.error(`[${this.name}] deferred ${key} failed: ${e.message}`)
        );
      }, ms)
    );
  }

  startPolling() {
    this.refresh();
    this._poller = setInterval(() => this.refresh(), this.pollInterval);
    // Don't keep the event loop alive solely for polling.
    if (this._poller.unref) {
      this._poller.unref();
    }
  }

  /** Refresh shortly after a write so HomeKit reflects the real state. */
  scheduleRefresh() {
    setTimeout(() => this.refresh(), 1200).unref?.();
  }

  async refresh() {
    try {
      const state = await this.device.getState();
      this.state = state;
      this.applyState(state);
    } catch (e) {
      this.log.debug(`[${this.name}] poll failed: ${e.message}`);
    }
  }

  /** Push the freshly polled state into every characteristic. */
  applyState(state) {
    const { Characteristic } = this;
    const hp = state.heatpump || {};

    // Refine temperature limits from the device and remember climate mode.
    const coolMin = Number(hp.coolmin);
    const coolMax = Number(hp.coolmax);
    if (Number.isFinite(coolMin) && Number.isFinite(coolMax) && coolMax > coolMin) {
      if (coolMin !== this.minTemp || coolMax !== this.maxTemp) {
        this.minTemp = coolMin;
        this.maxTemp = coolMax;
        const props = { minValue: this.minTemp, maxValue: this.maxTemp, minStep: TEMP_STEP };
        this.hc.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps(props);
        this.hc.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps(props);
      }
    }
    if (hp.mode === 'heat' || hp.mode === 'cool' || hp.mode === 'auto') {
      this.lastClimateMode = hp.mode;
    }

    // Accessory information from the firmware block.
    if (state.fw && state.fw.curr) {
      this.infoService.updateCharacteristic(Characteristic.FirmwareRevision, String(state.fw.curr));
    }
    if (state.fw && state.fw.model) {
      this.infoService.updateCharacteristic(Characteristic.Model, String(state.fw.model));
    }
    if (state.sys && state.sys.id) {
      this.infoService.updateCharacteristic(Characteristic.SerialNumber, String(state.sys.id));
    }
    if (state.sys && state.sys.frname) {
      // Keep the friendly room name visible but don't override the user's HomeKit name.
      this.log.debug(`[${this.name}] device room name: ${state.sys.frname}`);
    }

    this.hc.updateCharacteristic(Characteristic.Active, this.getActive());
    this.hc.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, this.getCurrentState());
    this.hc.updateCharacteristic(Characteristic.TargetHeaterCoolerState, this.getTargetState());
    this.hc.updateCharacteristic(Characteristic.CurrentTemperature, this.getCurrentTemperature());
    this.hc.updateCharacteristic(
      Characteristic.CoolingThresholdTemperature,
      this.getTargetTemperature()
    );
    this.hc.updateCharacteristic(
      Characteristic.HeatingThresholdTemperature,
      this.getTargetTemperature()
    );
    this.hc.updateCharacteristic(Characteristic.RotationSpeed, this.getRotationSpeed());
    this.hc.updateCharacteristic(Characteristic.SwingMode, this.getSwing());

    if (this.silentSwitch) {
      this.silentSwitch.updateCharacteristic(
        Characteristic.On,
        this.boolFromOnOff(hp.silent_mode)
      );
    }
    if (this.fanAutoSwitch) {
      this.fanAutoSwitch.updateCharacteristic(Characteristic.On, hp.fan === 'auto');
    }
    if (this.drySwitch) {
      this.drySwitch.updateCharacteristic(
        Characteristic.On,
        hp.mode === 'dry' && hp.power === 'on'
      );
    }
    if (this.fanModeSwitch) {
      this.fanModeSwitch.updateCharacteristic(
        Characteristic.On,
        hp.mode === 'fan' && hp.power === 'on'
      );
    }
  }
}

module.exports = { MhiAccessory };
