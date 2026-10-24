'use strict';

const DEFAULT_MIN_TEMP = 16;
const DEFAULT_MAX_TEMP = 31;
const UNPAIRED_MAC = '00:00:00:00:00:00';

function finiteNumber(v) {
  if (v === null || v === undefined || v === '') {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function range(min, max) {
  const lo = finiteNumber(min);
  const hi = finiteNumber(max);
  if (lo === undefined || hi === undefined || hi <= lo) {
    return { min: DEFAULT_MIN_TEMP, max: DEFAULT_MAX_TEMP };
  }
  return { min: lo, max: hi };
}

/** Setpoint limits the device accepts in `mode`, matching the web app. */
function temperatureLimits(hp, mode) {
  const heat = range(hp.heatmin, hp.heatmax);
  const cool = range(hp.coolmin, hp.coolmax);
  switch (mode) {
    case 'heat':
      return heat;
    case 'cool':
    case 'dry':
      return cool;
    default:
      return { min: cool.min, max: heat.max };
  }
}

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

/** @returns {'inactive'|'idle'|'heating'|'cooling'} */
function currentActivity(hp) {
  if (hp.power !== 'on') {
    return 'inactive';
  }
  const op = hp.op || {};
  if (op.defrost === true) {
    return 'idle';
  }
  const compressorFrequency = finiteNumber(op.compr_freq);
  if (compressorFrequency !== undefined && compressorFrequency <= 0) {
    return 'idle';
  }
  switch (hp.mode) {
    case 'heat':
      return 'heating';
    case 'cool':
    case 'dry':
      return 'cooling';
    case 'fan':
      return 'idle';
    default: {
      const actual = finiteNumber(hp.actual_temperature);
      const target = finiteNumber(hp.set_temperature);
      if (actual !== undefined && target !== undefined) {
        if (actual > target + 0.5) return 'cooling';
        if (actual < target - 0.5) return 'heating';
      }
      return 'idle';
    }
  }
}

function hasFault(state) {
  const hp = state.heatpump || {};
  const errorCode = finiteNumber(hp.error_code);
  return (errorCode !== undefined && errorCode !== 0) || (state.sys || {}).conhp === false;
}

/** The sensor block when a sensor is paired to that slot, otherwise undefined. */
function pairedSensor(block) {
  if (!block || typeof block !== 'object' || !block.mac || block.mac === UNPAIRED_MAC) {
    return undefined;
  }
  return block;
}

/** @returns {'open'|'closed'|undefined} undefined when the reported state is not recognised */
function contactState(value) {
  const v = String(value).trim().toLowerCase();
  if (v === 'open' || v === 'opened') return 'open';
  if (v === 'closed' || v === 'close') return 'closed';
  return undefined;
}

module.exports = {
  finiteNumber,
  temperatureLimits,
  clamp,
  currentActivity,
  hasFault,
  pairedSensor,
  contactState,
};
