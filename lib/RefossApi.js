'use strict';

const http = require('http');

// Refoss local HTTP API wrapper
//
// Real API (confirmed from official docs):
//   http://<ip>/rpc/<Method>?params
//
// Em.Status.Get response — values already in SI units:
//   { result: { status: [ { id:1, current, voltage, power, pf,
//                            month_energy, week_energy, day_energy, ... }, ... ] } }
//
// Channels are identified by integer id (1-based), NOT string prefixes like a/b/c.
// No unit conversion needed — device returns W, V, A, kWh directly.

const REQUEST_TIMEOUT_MS = 8000;

class RefossApi {

  constructor(ipAddress) {
    this.ipAddress = ipAddress;
  }

  // ---------------------------------------------------------------------------
  // Low-level transport
  // ---------------------------------------------------------------------------

  _get(path) {
    return new Promise((resolve, reject) => {
      const url = `http://${this.ipAddress}/rpc/${path}`;
      const req = http.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from device`));
          }
          try {
            const parsed = JSON.parse(body);
            if (parsed.code !== undefined && parsed.code < 0) {
              return reject(new Error(`Device error ${parsed.code}: ${parsed.message}`));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Invalid JSON: ${body.slice(0, 120)}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout calling ${url}`));
      });
    });
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const options = {
        hostname: this.ipAddress,
        port: 80,
        path: `/rpc/${path}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from device`));
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.code !== undefined && parsed.code < 0) {
              return reject(new Error(`Device error ${parsed.code}: ${parsed.message}`));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Invalid JSON: ${data.slice(0, 120)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout POSTing to /rpc/${path}`));
      });
      req.write(payload);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Device identity
  // ---------------------------------------------------------------------------

  async getSystemInfo() {
    return this._get('Refoss.GetDeviceInfo');
  }

  // ---------------------------------------------------------------------------
  // Em.Status.Get — live readings for all channels
  //
  // Response: { result: { status: [ { id, current, voltage, power, pf,
  //              month_energy, month_ret_energy, week_energy, week_ret_energy,
  //              day_energy, day_ret_energy }, ... ] } }
  //
  // id=65535 queries all EM modules at once.
  // Values are already in SI units: W, V, A, kWh — no conversion needed.
  // ---------------------------------------------------------------------------

  async getEmStatus() {
    return this._get('Em.Status.Get?id=65535');
  }

  // ---------------------------------------------------------------------------
  // Em.Data.Get — historical energy data
  //
  // start_ts / end_ts are Unix timestamps (seconds).
  // Returns columnar data with keys: energy, ret_energy, voltage_max/min/avg,
  //   current_max/min/avg, power_max/min/avg.
  // ---------------------------------------------------------------------------

  async getEmData(startTs, endTs) {
    const now = Math.floor(Date.now() / 1000);
    const end = endTs || now;
    const start = startTs || (end - 86400); // default: last 24 hours
    return this._get(`Em.Data.Get?id=65535&start_ts=${start}&end_ts=${end}`);
  }

  // ---------------------------------------------------------------------------
  // Em.Config.Get — channel names
  // ---------------------------------------------------------------------------

  async getEmConfig() {
    return this._get('Em.Config.Get?id=65535');
  }

  // ---------------------------------------------------------------------------
  // Webhook management
  //
  // Refoss webhook limits:
  //   - Max 20 webhooks per device
  //   - Max 5 URLs per webhook
  //   - Max 300 chars per URL
  //
  // We use event "em.status_update" (or the supported equivalent returned by
  // Webhook.Supported.List). We register one webhook pointing at the Homey
  // HTTP listener URL so the device POSTs NotifyStatus on every value change.
  // ---------------------------------------------------------------------------

  async getSupportedWebhookEvents() {
    return this._get('Webhook.Supported.List');
  }

  async listWebhooks() {
    return this._get('Webhook.List');
  }

  async createWebhook({ name, event, cid, urls, repeatPeriod = 0 }) {
    return this._post('Webhook.Create', {
      name,
      event,
      cid: cid !== undefined ? cid : 1,
      enable: true,
      urls,
      repeat_period: repeatPeriod,
    });
  }

  async deleteWebhook(id) {
    return this._get(`Webhook.Delete?id=${id}`);
  }

  async deleteAllWebhooks() {
    return this._get('Webhook.DeleteAll');
  }

  // ---------------------------------------------------------------------------
  // Register the Homey webhook — idempotent:
  //   1. List existing webhooks.
  //   2. Delete any stale Homey webhooks (name matches ours).
  //   3. Create a fresh webhook pointing at homeyUrl.
  //
  // Returns the created webhook id.
  // ---------------------------------------------------------------------------

  async registerHomeyWebhook(homeyUrl, emEvent) {
    const HOOK_NAME = 'homey-refoss';

    // Remove any previously registered Homey webhooks for this device
    try {
      const listResp = await this.listWebhooks();
      const hooks = (listResp.result && listResp.result.hooks) || [];
      for (const hook of hooks) {
        if (hook.name === HOOK_NAME) {
          await this.deleteWebhook(hook.id).catch(() => {});
        }
      }
    } catch (_) {
      // If listing fails, proceed anyway and try to create
    }

    const resp = await this.createWebhook({
      name: HOOK_NAME,
      event: emEvent,
      cid: 1,
      urls: [homeyUrl],
      repeatPeriod: 0,
    });

    const result = resp.result || resp;
    return result.id;
  }

  // ---------------------------------------------------------------------------
  // Remove any Homey-registered webhooks from the device
  // ---------------------------------------------------------------------------

  async unregisterHomeyWebhook() {
    const HOOK_NAME = 'homey-refoss';
    try {
      const listResp = await this.listWebhooks();
      const hooks = (listResp.result && listResp.result.hooks) || [];
      for (const hook of hooks) {
        if (hook.name === HOOK_NAME) {
          await this.deleteWebhook(hook.id).catch(() => {});
        }
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Parse Em.Status.Get response
  //
  // Returns a map: { <channelId>: { power, voltage, current, pf,
  //                                 monthEnergy, weekEnergy, dayEnergy } }
  // channelId is a 1-based integer matching the device's id field.
  // ---------------------------------------------------------------------------

  static parseEmStatus(raw) {
    const result      = raw.result || {};
    const statusArray = result.status || [];
    const map = {};
    let totalPower = 0;
    let totalCurrent = 0;

    // Device-level temperature — reported at result.temperature or result.sys.temperature
    const temp = result.temperature !== undefined
      ? result.temperature
      : (result.sys && result.sys.temperature !== undefined ? result.sys.temperature : null);
    map.temperature = temp;

    for (const ch of statusArray) {
      // Apparent power: use apower field if present, otherwise derive from power / pf
      const apower = ch.apower !== undefined
        ? ch.apower
        : (ch.power !== undefined && ch.pf != null && ch.pf !== 0)
          ? ch.power / ch.pf
          : null;

      map[ch.id] = {
        power:           ch.power            !== undefined ? ch.power            : null,
        voltage:         ch.voltage          !== undefined ? ch.voltage          : null,
        current:         ch.current          !== undefined ? ch.current          : null,
        pf:              ch.pf               !== undefined ? ch.pf               : null,
        apparentPower:   apower,
        monthEnergy:     ch.month_energy     !== undefined ? ch.month_energy     : null,
        weekEnergy:      ch.week_energy      !== undefined ? ch.week_energy      : null,
        dayEnergy:       ch.day_energy       !== undefined ? ch.day_energy       : null,
        monthRetEnergy:  ch.month_ret_energy !== undefined ? ch.month_ret_energy : null,
        weekRetEnergy:   ch.week_ret_energy  !== undefined ? ch.week_ret_energy  : null,
        dayRetEnergy:    ch.day_ret_energy   !== undefined ? ch.day_ret_energy   : null,
      };
      if (ch.power   !== undefined) totalPower   += ch.power;
      if (ch.current !== undefined) totalCurrent += ch.current;
    }

    map.total = { power: totalPower, current: totalCurrent };
    return map;
  }

  // ---------------------------------------------------------------------------
  // Parse a NotifyStatus webhook push body
  //
  // Device POSTs:
  // {
  //   "src": "refoss-em06p-xxxx",
  //   "method": "NotifyStatus",
  //   "params": {
  //     "ts": 1704695819000,
  //     "em": { "id": 1, "power": 123.4, "voltage": 230.1, "current": 0.54, ... }
  //   }
  // }
  //
  // Returns parsed channel data in the same shape as parseEmStatus entries,
  // or null if the body is not an em NotifyStatus.
  // ---------------------------------------------------------------------------

  static parseNotifyStatus(body) {
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      if (parsed.method !== 'NotifyStatus') return null;

      const params = parsed.params || {};
      const em = params.em;
      if (!em || em.id === undefined) return null;

      // Apparent power: use apower field if present, otherwise derive from power / pf
      const apower = em.apower !== undefined
        ? em.apower
        : (em.power !== undefined && em.pf != null && em.pf !== 0)
          ? em.power / em.pf
          : null;

      return {
        channelId:       em.id,
        power:           em.power             !== undefined ? em.power             : null,
        voltage:         em.voltage           !== undefined ? em.voltage           : null,
        current:         em.current           !== undefined ? em.current           : null,
        pf:              em.pf                !== undefined ? em.pf                : null,
        apparentPower:   apower,
        monthEnergy:     em.month_energy      !== undefined ? em.month_energy      : null,
        weekEnergy:      em.week_energy       !== undefined ? em.week_energy       : null,
        dayEnergy:       em.day_energy        !== undefined ? em.day_energy        : null,
        monthRetEnergy:  em.month_ret_energy  !== undefined ? em.month_ret_energy  : null,
        weekRetEnergy:   em.week_ret_energy   !== undefined ? em.week_ret_energy   : null,
        dayRetEnergy:    em.day_ret_energy    !== undefined ? em.day_ret_energy    : null,
      };
    } catch (_) {
      return null;
    }
  }

}

// ---------------------------------------------------------------------------
// Channel definitions per model — channels are 1-based integer IDs
// ---------------------------------------------------------------------------

// EM06P: 6 channels, ids 1–6
RefossApi.EM06P_CHANNELS = [
  { id: 1, label: 'A1' },
  { id: 2, label: 'B1' },
  { id: 3, label: 'C1' },
  { id: 4, label: 'A2' },
  { id: 5, label: 'B2' },
  { id: 6, label: 'C2' },
];

// EM16P: 18 channels, ids 1–18
RefossApi.EM16P_CHANNELS = [
  { id:  1, label: 'A1' }, { id:  2, label: 'A2' }, { id:  3, label: 'A3' },
  { id:  4, label: 'A4' }, { id:  5, label: 'A5' }, { id:  6, label: 'A6' },
  { id:  7, label: 'B1' }, { id:  8, label: 'B2' }, { id:  9, label: 'B3' },
  { id: 10, label: 'B4' }, { id: 11, label: 'B5' }, { id: 12, label: 'B6' },
  { id: 13, label: 'C1' }, { id: 14, label: 'C2' }, { id: 15, label: 'C3' },
  { id: 16, label: 'C4' }, { id: 17, label: 'C5' }, { id: 18, label: 'C6' },
];

// EM01P: 1 channel, id 1
RefossApi.EM01P_CHANNELS = [
  { id: 1, label: 'A1' },
];

// The event name used when registering a webhook for Em status changes.
// Query Webhook.Supported.List on the device to confirm; this is the expected value.
RefossApi.EM_WEBHOOK_EVENT = 'em.status_update';

module.exports = RefossApi;
