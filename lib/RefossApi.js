'use strict';

const http   = require('http');
const crypto = require('crypto');

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
//
// Authentication: the device may be password-protected via HTTP Digest auth (RFC 2617).
// Pass username + password to the constructor. If the device returns 401 the library
// automatically retries with the correct Digest Authorization header.

const REQUEST_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Digest auth helpers
// ---------------------------------------------------------------------------

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// Parse WWW-Authenticate: Digest realm="...", nonce="...", qop="auth", ...
function parseDigestChallenge(header) {
  const params = {};
  const re = /(\w+)="([^"]+)"/g;
  let m;
  while ((m = re.exec(header)) !== null) params[m[1]] = m[2];
  return params;
}

function buildDigestHeader({ username, password, method, path, challenge, nc, cnonce }) {
  const { realm, nonce, qop, opaque, algorithm } = challenge;
  const ha1 = (algorithm || '').toUpperCase() === 'MD5-SESS'
    ? md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:${cnonce}`)
    : md5(`${username}:${realm}:${password}`);
  const ha2      = md5(`${method}:${path}`);
  const ncHex    = nc.toString(16).padStart(8, '0');
  const response = qop
    ? md5(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${response}"`;
  if (qop)    header += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

// Drain an http.IncomingMessage and return the body as a string
function readBody(res) {
  return new Promise((resolve) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve(body));
  });
}

// Parse and validate JSON from device
function parseJson(text, label) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) {
    throw new Error(`Invalid JSON from ${label}: ${text.slice(0, 120)}`);
  }
  if (parsed.code !== undefined && parsed.code < 0)
    throw new Error(`Device error ${parsed.code}: ${parsed.message}`);
  return parsed;
}

class RefossApi {

  constructor(ipAddress, username, password) {
    this.ipAddress = ipAddress;
    this.username  = username || null;
    this.password  = password || null;
    this._nc       = 0; // nonce count, incremented per authenticated request
  }

  // ---------------------------------------------------------------------------
  // Low-level transport — GET and POST both auto-retry with Digest auth on 401
  // ---------------------------------------------------------------------------

  async _get(path) {
    const urlPath = `/rpc/${path}`;

    const makeReq = (extraHeaders) => new Promise((resolve, reject) => {
      const opts = {
        hostname: this.ipAddress,
        port: 80,
        path: urlPath,
        method: 'GET',
        headers: { ...extraHeaders },
        timeout: REQUEST_TIMEOUT_MS,
      };
      const req = http.request(opts, resolve);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout calling ${urlPath}`)); });
      req.end();
    });

    const res1  = await makeReq({});
    const body1 = await readBody(res1);

    if (res1.statusCode === 401) {
      if (!this.username)
        throw new Error('Device requires authentication — set username and password in device settings');
      const challenge = parseDigestChallenge(res1.headers['www-authenticate'] || '');
      this._nc++;
      const cnonce    = crypto.randomBytes(8).toString('hex');
      const authHeader = buildDigestHeader({
        username: this.username, password: this.password,
        method: 'GET', path: urlPath, challenge, nc: this._nc, cnonce,
      });
      const res2  = await makeReq({ Authorization: authHeader });
      const body2 = await readBody(res2);
      if (res2.statusCode === 401)
        throw new Error('Authentication failed — check username and password');
      if (res2.statusCode !== 200)
        throw new Error(`HTTP ${res2.statusCode} from device`);
      return parseJson(body2, urlPath);
    }

    if (res1.statusCode !== 200)
      throw new Error(`HTTP ${res1.statusCode} from device`);
    return parseJson(body1, urlPath);
  }

  async _post(path, body) {
    const urlPath = `/rpc/${path}`;
    const payload = JSON.stringify(body);

    const makeReq = (extraHeaders) => new Promise((resolve, reject) => {
      const opts = {
        hostname: this.ipAddress,
        port: 80,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...extraHeaders,
        },
        timeout: REQUEST_TIMEOUT_MS,
      };
      const req = http.request(opts, resolve);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout POSTing to ${urlPath}`)); });
      req.write(payload);
      req.end();
    });

    const res1  = await makeReq({});
    const data1 = await readBody(res1);

    if (res1.statusCode === 401) {
      if (!this.username)
        throw new Error('Device requires authentication — set username and password in device settings');
      const challenge = parseDigestChallenge(res1.headers['www-authenticate'] || '');
      this._nc++;
      const cnonce    = crypto.randomBytes(8).toString('hex');
      const authHeader = buildDigestHeader({
        username: this.username, password: this.password,
        method: 'POST', path: urlPath, challenge, nc: this._nc, cnonce,
      });
      const res2  = await makeReq({ Authorization: authHeader });
      const data2 = await readBody(res2);
      if (res2.statusCode === 401)
        throw new Error('Authentication failed — check username and password');
      if (res2.statusCode !== 200)
        throw new Error(`HTTP ${res2.statusCode} from device`);
      return parseJson(data2, urlPath);
    }

    if (res1.statusCode !== 200)
      throw new Error(`HTTP ${res1.statusCode} from device`);
    return parseJson(data1, urlPath);
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
    const now   = Math.floor(Date.now() / 1000);
    const end   = endTs   || now;
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
        if (hook.name === HOOK_NAME)
          await this.deleteWebhook(hook.id).catch(() => {});
      }
    } catch (_) {
      // If listing fails, proceed anyway and try to create
    }

    const resp   = await this.createWebhook({
      name: HOOK_NAME, event: emEvent, cid: 1, urls: [homeyUrl], repeatPeriod: 0,
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
        if (hook.name === HOOK_NAME)
          await this.deleteWebhook(hook.id).catch(() => {});
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Parse Em.Status.Get response
  //
  // Returns a map: { <channelId>: { power, voltage, current, pf,
  //                                 monthEnergy, weekEnergy, dayEnergy,
  //                                 monthRetEnergy, weekRetEnergy, dayRetEnergy },
  //                  total: { power, current },
  //                  temperature: <number|null> }
  // channelId is a 1-based integer matching the device's id field.
  // ---------------------------------------------------------------------------

  static parseEmStatus(raw) {
    const result      = raw.result || {};
    const statusArray = result.status || [];
    const map         = {};
    let totalPower   = 0;
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
      const em     = params.em;
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
