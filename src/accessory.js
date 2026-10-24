'use strict';

const { MhiDevice } = require('./device');
const { SensorServices } = require('./sensors');
const { ensureNamedService } = require('./services');
const { temperatureLimits, clamp, currentActivity, hasFault } = require('./mapping');

const DEFAULT_POLL_INTERVAL = 10; // seconds
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
    // Remembers the last heat/cool/auto mode so the Dry/Fan switches can revert.
    this.lastClimateMode = 'cool';
    // Shown on the speed slider while the fan runs on auto.
    this.lastManualFan = null;
    this.lastProtection = undefined;

    this._setTimers = new Map();

    this.setupServices();
    this.sensors = new SensorServices({
      accessory,
      hap: platform.api.hap,
      config,
      log: this.log,
      name: this.name,
      onServicesChanged: () => platform.api.updatePlatformAccessories([accessory]),
    });
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

    this.hc
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps(this.thresholdProps('cool'))
      .onGet(() => this.getThresholdTemperature('cool'))
      .onSet((v) => this.setTargetTemperature(v));
    this.hc
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps(this.thresholdProps('heat'))
      .onGet(() => this.getThresholdTemperature('heat'))
      .onSet((v) => this.setTargetTemperature(v));

    // HeaterCooler doesn't list StatusFault as optional; register it so HAP
    // doesn't warn about an unknown characteristic.
    if (!this.hc.testCharacteristic(Characteristic.StatusFault)) {
      this.hc.addOptionalCharacteristic(Characteristic.StatusFault);
    }
    this.hc
      .getCharacteristic(Characteristic.StatusFault)
      .onGet(() => this.getStatusFault());

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

    if (!enabled) {
      const existing = this.accessory.getServiceById(Service.Switch, subtype);
      if (existing) {
        this.accessory.removeService(existing);
      }
      return null;
    }

    const svc = ensureNamedService(this.accessory, this.platform.api.hap, Service.Switch, label, subtype);
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

  heatpump() {
    return (this.state && this.state.heatpump) || {};
  }

  /** Safe access to a heatpump field from the last polled state. */
  heat(field) {
    return this.heatpump()[field];
  }

  boolFromOnOff(v) {
    return v === 'on' || v === true;
  }

  /** @param {'heat'|'cool'} kind */
  thresholdProps(kind) {
    const { min, max } = temperatureLimits(this.heatpump(), kind);
    return { minValue: min, maxValue: max, minStep: TEMP_STEP };
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

  /** @param {'heat'|'cool'} kind */
  getThresholdTemperature(kind) {
    const limits = temperatureLimits(this.heatpump(), kind);
    const t = this.heat('set_temperature');
    return clamp(typeof t === 'number' ? t : limits.min, limits);
  }

  getStatusFault() {
    const { StatusFault } = this.Characteristic;
    return this.state && hasFault(this.state) ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT;
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
    const S = this.Characteristic.CurrentHeaterCoolerState;
    switch (currentActivity(this.heatpump())) {
      case 'heating':
        return S.HEATING;
      case 'cooling':
        return S.COOLING;
      case 'idle':
        return S.IDLE;
      default:
        return S.INACTIVE;
    }
  }

  getRotationSpeed() {
    const fan = this.heat('fan');
    let idx = FAN_SPEEDS.indexOf(String(fan));
    if (idx === -1) {
      idx = FAN_SPEEDS.indexOf(this.lastManualFan);
    }
    // Auto before any manual speed was seen: full speed is the least surprising.
    return idx === -1 ? 100 : (idx + 1) * 25;
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
    const limits = temperatureLimits(this.heatpump(), this.heat('mode'));
    const rounded = clamp(Math.round(value * 2) / 2, limits);
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
      this.applyState(await this.device.getState());
    } catch (e) {
      this.log.debug(`[${this.name}] poll failed: ${e.message}`);
    }
  }

  /** Push the freshly polled state into every characteristic. */
  applyState(state) {
    const { Characteristic } = this;
    this.state = state;
    const hp = state.heatpump || {};

    const limits = JSON.stringify([this.thresholdProps('cool'), this.thresholdProps('heat')]);
    if (limits !== this.appliedLimits) {
      this.appliedLimits = limits;
      this.hc
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps(this.thresholdProps('cool'));
      this.hc
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps(this.thresholdProps('heat'));
    }
    if (hp.mode === 'heat' || hp.mode === 'cool' || hp.mode === 'auto') {
      this.lastClimateMode = hp.mode;
    }
    if (FAN_SPEEDS.includes(String(hp.fan))) {
      this.lastManualFan = String(hp.fan);
    }
    this.logProtectionChange((hp.op || {}).protection);

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
      this.getThresholdTemperature('cool')
    );
    this.hc.updateCharacteristic(
      Characteristic.HeatingThresholdTemperature,
      this.getThresholdTemperature('heat')
    );
    this.hc.updateCharacteristic(Characteristic.StatusFault, this.getStatusFault());
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

    this.sensors.apply(state);
  }

  logProtectionChange(protection) {
    if (protection === undefined || protection === this.lastProtection) {
      return;
    }
    const wasAbnormal = this.lastProtection !== undefined && this.lastProtection !== 'Normal';
    this.lastProtection = protection;
    if (protection !== 'Normal') {
      this.log.warn(`[${this.name}] Protection active: ${protection}`);
    } else if (wasAbnormal) {
      this.log.info(`[${this.name}] Protection back to normal`);
    }
  }
}

module.exports = { MhiAccessory };
