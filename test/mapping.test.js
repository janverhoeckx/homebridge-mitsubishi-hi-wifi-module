'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MhiAccessory } = require('../src/accessory');

// --- Minimal HAP mock -------------------------------------------------------
function mkChar(id) {
  return {
    id, value: undefined, props: {},
    onGet(f) { this._get = f; return this; },
    onSet(f) { this._set = f; return this; },
    setProps(p) { Object.assign(this.props, p); return this; },
    updateValue(v) { this.value = v; return this; },
  };
}
class FakeService {
  constructor(name, subtype) { this.name = name; this.subtype = subtype; this.chars = new Map(); }
  getCharacteristic(c) { const k = c.__id; if (!this.chars.has(k)) this.chars.set(k, mkChar(k)); return this.chars.get(k); }
  setCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  updateCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  testCharacteristic(c) { return this.chars.has(c.__id); }
  addOptionalCharacteristic() {}
  value(c) { return this.getCharacteristic(c).value; }
}
function ce(id, extra = {}) { return { __id: id, toString: () => id, ...extra }; }
const Characteristic = {
  Manufacturer: ce('Manufacturer'), Model: ce('Model'), SerialNumber: ce('SerialNumber'),
  FirmwareRevision: ce('FirmwareRevision'), Name: ce('Name'),
  Active: ce('Active', { ACTIVE: 1, INACTIVE: 0 }),
  CurrentHeaterCoolerState: ce('CurrentHeaterCoolerState', { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 }),
  TargetHeaterCoolerState: ce('TargetHeaterCoolerState', { AUTO: 0, HEAT: 1, COOL: 2 }),
  CurrentTemperature: ce('CurrentTemperature'),
  CoolingThresholdTemperature: ce('CoolingThresholdTemperature'),
  HeatingThresholdTemperature: ce('HeatingThresholdTemperature'),
  RotationSpeed: ce('RotationSpeed'),
  SwingMode: ce('SwingMode', { SWING_ENABLED: 1, SWING_DISABLED: 0 }),
  On: ce('On'),
  StatusFault: ce('StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }),
  CurrentRelativeHumidity: ce('CurrentRelativeHumidity'),
  BatteryLevel: ce('BatteryLevel'),
  StatusLowBattery: ce('StatusLowBattery', { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 }),
  ChargingState: ce('ChargingState', { NOT_CHARGEABLE: 2 }),
  ContactSensorState: ce('ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }),
};
const Service = Object.fromEntries(
  ['AccessoryInformation', 'HeaterCooler', 'Switch', 'TemperatureSensor', 'HumiditySensor', 'Battery', 'ContactSensor']
    .map((id) => [id, { __id: id }])
);
class FakeAccessory {
  constructor() { this.services = []; this.context = {}; }
  getService(t) { return this.services.find((s) => s._type === t.__id && !s.subtype); }
  getServiceById(t, sub) { return this.services.find((s) => s._type === t.__id && s.subtype === sub); }
  addService(t, name, sub) { const s = new FakeService(name, sub); s._type = t.__id; this.services.push(s); return s; }
  removeService(s) { this.services = this.services.filter((x) => x !== s); }
}
function makePlatform() {
  return {
    warnings: [],
    log: { info() {}, warn(m) { this.owner.warnings.push(m); }, error() {}, debug() {} },
    Service, Characteristic,
    api: {
      hap: { Service, Characteristic, HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } },
      updatePlatformAccessories() {},
    },
  };
}

function makeAccessory(cfg = {}) {
  const platform = makePlatform();
  platform.log.owner = platform;
  const proto = MhiAccessory.prototype;
  const orig = proto.startPolling;
  proto.startPolling = () => {};
  const a = new MhiAccessory(platform, new FakeAccessory(), { name: 'AC', host: 'x.local', ...cfg });
  proto.startPolling = orig;
  return a;
}

function service(a, type, subtype) {
  return a.accessory.getServiceById(Service[type], subtype);
}

function withState(hp) {
  return { heatpump: { heatmin: 16, heatmax: 31, coolmin: 16, coolmax: 31, ...hp } };
}

const C = Characteristic;

test('cool mode maps to COOL/COOLING', () => {
  const a = makeAccessory();
  a.state = withState({ power: 'on', mode: 'cool', set_temperature: 22, actual_temperature: 25, fan: '4', auto3d: 'off' });
  assert.equal(a.getActive(), C.Active.ACTIVE);
  assert.equal(a.getTargetState(), C.TargetHeaterCoolerState.COOL);
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.COOLING);
  assert.equal(a.getThresholdTemperature('cool'), 22);
  assert.equal(a.getCurrentTemperature(), 25);
  assert.equal(a.getRotationSpeed(), 100);
});

test('heat mode maps to HEAT/HEATING', () => {
  const a = makeAccessory();
  a.state = withState({ power: 'on', mode: 'heat', set_temperature: 21, actual_temperature: 18, fan: '2' });
  assert.equal(a.getTargetState(), C.TargetHeaterCoolerState.HEAT);
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.HEATING);
  assert.equal(a.getRotationSpeed(), 50);
});

test('auto mode derives current state from temperature delta', () => {
  const a = makeAccessory();
  a.state = withState({ power: 'on', mode: 'auto', set_temperature: 22, actual_temperature: 25 });
  assert.equal(a.getTargetState(), C.TargetHeaterCoolerState.AUTO);
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.COOLING);
  a.state = withState({ power: 'on', mode: 'auto', set_temperature: 22, actual_temperature: 19 });
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.HEATING);
  a.state = withState({ power: 'on', mode: 'auto', set_temperature: 22, actual_temperature: 22 });
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.IDLE);
});

test('power off reports INACTIVE', () => {
  const a = makeAccessory();
  a.state = withState({ power: 'off', mode: 'cool' });
  assert.equal(a.getActive(), C.Active.INACTIVE);
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.INACTIVE);
});

test('fan auto and swing', () => {
  const a = makeAccessory();
  a.state = withState({ power: 'on', mode: 'fan', fan: 'auto', auto3d: 'on' });
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.IDLE);
  assert.equal(a.getSwing(), C.SwingMode.SWING_ENABLED);
});

test('setter sends the right device parameters', async () => {
  const a = makeAccessory();
  a.state = withState({ power: 'on', mode: 'cool', set_temperature: 22 });
  const sent = [];
  a.device.setParam = async (p, v) => { sent.push([p, v]); };

  await a.setActive(C.Active.INACTIVE);
  await a.setTargetState(C.TargetHeaterCoolerState.HEAT);
  await a.setSwing(C.SwingMode.SWING_ENABLED);

  assert.deepEqual(sent[0], ['power', 'off']);
  assert.deepEqual(sent[1], ['mode', 'heat']);
  assert.deepEqual(sent[2], ['auto3d', 'on']);
  assert.equal(a.lastClimateMode, 'heat');
});

test('rotation speed 0 powers off; otherwise maps to fan step', async () => {
  const a = makeAccessory();
  a.state = withState({ power: 'on', mode: 'cool' });
  const sent = [];
  a.device.setParam = async (p, v) => { sent.push([p, v]); };
  await a.setRotationSpeed(0);
  assert.deepEqual(sent[0], ['power', 'off']);
  await a.setRotationSpeed(75);
  await new Promise((r) => setTimeout(r, 500)); // debounce
  assert.deepEqual(sent[1], ['fan', '3']);
});

test('optional switches are created/omitted per config', () => {
  const on = makeAccessory({ exposeDryMode: true, exposeFanMode: true });
  const names = on.accessory.services.filter((s) => s._type === 'Switch').map((s) => s.subtype).sort();
  assert.deepEqual(names, ['auto_fan', 'dry', 'fan_only', 'silent']);

  const off = makeAccessory({ exposeSilentMode: false, exposeFanAuto: false });
  const names2 = off.accessory.services.filter((s) => s._type === 'Switch').map((s) => s.subtype);
  assert.deepEqual(names2, []);
});

test('heating threshold uses the heat range and setpoints are clamped to the mode range', async () => {
  const a = makeAccessory();
  a.applyState(withState({ power: 'on', mode: 'heat', heatmin: 10, heatmax: 30, coolmin: 18, coolmax: 32, set_temperature: 12 }));
  assert.equal(a.hc.getCharacteristic(C.HeatingThresholdTemperature).props.minValue, 10);
  assert.equal(a.hc.getCharacteristic(C.CoolingThresholdTemperature).props.minValue, 18);
  assert.equal(a.getThresholdTemperature('heat'), 12);

  const sent = [];
  a.device.setParam = async (p, v) => { sent.push([p, v]); };
  a.setTargetTemperature(31);
  await new Promise((r) => setTimeout(r, 500)); // debounce
  assert.deepEqual(sent[0], ['set_temperature', 30]);
});

test('stopped compressor or defrost reports IDLE instead of heating', () => {
  const a = makeAccessory();
  a.state = withState({ power: 'on', mode: 'heat', op: { compr_freq: 0, defrost: false } });
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.IDLE);
  a.state = withState({ power: 'on', mode: 'heat', op: { compr_freq: 60, defrost: true } });
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.IDLE);
  a.state = withState({ power: 'on', mode: 'heat', op: { compr_freq: 60, defrost: false } });
  assert.equal(a.getCurrentState(), C.CurrentHeaterCoolerState.HEATING);
});

test('error code or lost heatpump connection reports a fault', () => {
  const a = makeAccessory();
  a.state = { ...withState({ error_code: 0 }), sys: { conhp: true } };
  assert.equal(a.getStatusFault(), C.StatusFault.NO_FAULT);
  a.state = { ...withState({ error_code: 5 }), sys: { conhp: true } };
  assert.equal(a.getStatusFault(), C.StatusFault.GENERAL_FAULT);
  a.state = { ...withState({ error_code: 0 }), sys: { conhp: false } };
  assert.equal(a.getStatusFault(), C.StatusFault.GENERAL_FAULT);
});

test('auto fan keeps showing the last manual speed', () => {
  const a = makeAccessory();
  a.applyState(withState({ power: 'on', mode: 'cool', fan: '2' }));
  a.applyState(withState({ power: 'on', mode: 'cool', fan: 'auto' }));
  assert.equal(a.getRotationSpeed(), 50);
});

const PAIRED_THERMOMETER = { mac: 'A4:C1:38:DF:10:FE', hact: 70, batt: 15 };

test('outdoor temperature, humidity and thermometer battery are exposed', () => {
  const a = makeAccessory();
  a.applyState({ ...withState({ op: { outdoor: -3.5 } }), sensor: { thermometer: PAIRED_THERMOMETER } });

  assert.equal(service(a, 'TemperatureSensor', 'outdoor').value(C.CurrentTemperature), -3.5);
  const humidity = service(a, 'HumiditySensor', 'humidity');
  assert.equal(humidity.value(C.CurrentRelativeHumidity), 70);
  assert.equal(humidity.value(C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_LOW);
  assert.equal(service(a, 'Battery', 'thermometer_battery').value(C.BatteryLevel), 15);
});

test('thermometer services disappear when it is unpaired', () => {
  const a = makeAccessory();
  a.applyState({ ...withState({}), sensor: { thermometer: PAIRED_THERMOMETER } });
  a.applyState({ ...withState({}), sensor: { thermometer: { mac: '00:00:00:00:00:00' } } });
  assert.equal(service(a, 'HumiditySensor', 'humidity'), undefined);
  assert.equal(service(a, 'Battery', 'thermometer_battery'), undefined);
});

test('paired window sensors become contact sensors', () => {
  const a = makeAccessory();
  a.applyState({
    ...withState({}),
    sensor: {
      window: { mac: 'AA:BB:CC:DD:EE:01', state: 'open', batt: 80 },
      window_2: { mac: 'AA:BB:CC:DD:EE:03', state: 'closed' },
      window_1: { mac: '00:00:00:00:00:00' },
    },
  });
  assert.equal(service(a, 'ContactSensor', 'window').value(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
  assert.equal(service(a, 'ContactSensor', 'window_2').value(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
  assert.equal(service(a, 'ContactSensor', 'window_1'), undefined);
  assert.equal(service(a, 'ContactSensor', 'window_3'), undefined);
});

test('unrecognised window state is reported instead of guessed', () => {
  const a = makeAccessory();
  const state = { ...withState({}), sensor: { window: { mac: 'AA:BB:CC:DD:EE:01', state: 2 } } };
  a.applyState(state);
  a.applyState(state);
  assert.equal(service(a, 'ContactSensor', 'window').value(C.ContactSensorState), undefined);
  assert.equal(a.platform.warnings.filter((w) => w.includes('window sensor state')).length, 1);
});

test('sensors can be disabled in the config', () => {
  const a = makeAccessory({ exposeOutdoorTemperature: false, exposeThermometer: false, exposeWindowSensors: false });
  a.applyState({
    ...withState({ op: { outdoor: 10 } }),
    sensor: { thermometer: PAIRED_THERMOMETER, window: { mac: 'AA:BB:CC:DD:EE:01', state: 'open' } },
  });
  const types = a.accessory.services.map((s) => s._type);
  assert.deepEqual(types.filter((t) => !['AccessoryInformation', 'HeaterCooler', 'Switch'].includes(t)), []);
});
