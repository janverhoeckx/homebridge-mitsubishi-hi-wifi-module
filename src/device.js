'use strict';

/**
 * Thin HTTP client for the Mitsubishi Heavy Industries WiFi module
 * ("Climate Control" web app, firmware model MHI_CNS_ATA_WIFI).
 *
 * The module exposes a single endpoint:
 *   GET /control                                  -> full state as JSON
 *   GET /control?cmd=heatpump&<param>=<value>     -> set one heatpump parameter
 *
 * Known heatpump parameters (from the web app):
 *   power           on | off
 *   mode            heat | cool | auto | dry | fan
 *   set_temperature degrees Celsius, 0.5 step
 *   fan             1 | 2 | 3 | 4 | auto
 *   vane            1..7 | swing        (vertical louver)
 *   vanelr          1..7 | swing        (horizontal louver)
 *   auto3d          on | off            (3D auto airflow)
 *   silent_mode     on | off
 */
class MhiDevice {
  /**
   * @param {string} host   hostname or IP, e.g. "heatpump.local" or "192.168.1.50"
   * @param {object} [opts]
   * @param {number} [opts.timeout=8000]  request timeout in ms
   * @param {object} [opts.log]           Homebridge logger (optional)
   */
  constructor(host, opts = {}) {
    if (!host) {
      throw new Error('MhiDevice requires a host');
    }
    // Strip any scheme/trailing slash the user may have typed.
    this.host = String(host).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    this.timeout = opts.timeout || 8000;
    this.log = opts.log || console;
    this.baseUrl = `http://${this.host}`;
  }

  async _fetch(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch the full device state.
   * @returns {Promise<object>} parsed JSON state
   */
  async getState() {
    const res = await this._fetch(`${this.baseUrl}/control`);
    return res.json();
  }

  /**
   * Set a single heatpump parameter.
   * @param {string} param
   * @param {string|number} value
   * @returns {Promise<void>}
   */
  async setParam(param, value) {
    const url =
      `${this.baseUrl}/control?cmd=heatpump` +
      `&${encodeURIComponent(param)}=${encodeURIComponent(value)}`;
    await this._fetch(url);
  }
}

module.exports = { MhiDevice };
