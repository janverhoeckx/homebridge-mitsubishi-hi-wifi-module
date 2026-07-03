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
};
const Service = { AccessoryInformation: { __id: 'AccessoryInformation' }, HeaterCooler: { __id: 'HeaterCooler' }, Switch: { __id: 'Switch' } };
class FakeAccessory {
  constructor() { this.services = []; this.context = {}; }
  getService(t) { return this.services.find((s) => s._type === t.__id && !s.subtype); }
  getServiceById(t, sub) { return this.services.find((s) => s._type === t.__id && s.subtype === sub); }
  addService(t, name, sub) { const s = new FakeService(name, sub); s._type = t.__id; this.services.push(s); return s; }
  removeService(s) { this.services = this.services.filter((x) => x !== s); }
}
const platform = {
  log: { info() {}, warn() {}, error() {}, debug() {} },
  Service, Characteristic,
  api: { hap: { HapStatusError: class extends Error {}, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } },
};

function makeAccessory(cfg = {}) {
  const proto = MhiAccessory.prototype;
  const orig = proto.startPolling;
  proto.startPolling = () => {};
  const a = new MhiAccessory(platform, new FakeAccessory(), { name: 'AC', host: 'x.local', ...cfg });
  proto.startPolling = orig;
  return a;
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
  assert.equal(a.getTargetTemperature(), 22);
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
