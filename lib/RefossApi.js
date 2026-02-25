'use strict';

const http   = require('http');
const net    = require('net');
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
  // Devices sometimes return plain-text errors (not JSON) — surface these clearly.
  const trimmed = (text || '').trim();
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch (_) {
    throw new Error(`Device error from ${label}: ${trimmed.slice(0, 200)}`);
  }
  // Legacy flat error: { code: -1, message: "..." }
  if (parsed.code !== undefined && parsed.code < 0)
    throw new Error(`Device error ${parsed.code}: ${parsed.message}`);
  // JSON-RPC 2.0 error envelope: { error: { code: -1, message: "..." } }
  if (parsed.error && typeof parsed.error === 'object')
    throw new Error(`Device error ${parsed.error.code}: ${parsed.error.message}`);
  return parsed;
}

function looksLikeChannelStatus(value) {
  return value && typeof value === 'object'
    && (
      value.id !== undefined
      || value.power !== undefined
      || value.current !== undefined
      || value.voltage !== undefined
      || value.month_energy !== undefined
      || value.day_energy !== undefined
      || value.week_energy !== undefined
    );
}

function normalizeStatusArray(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const emKeyValues = Object.entries(result)
      .filter(([k, v]) => /^em:\d+$/i.test(k) && looksLikeChannelStatus(v))
      .sort((a, b) => {
        const ai = Number.parseInt(a[0].split(':')[1], 10);
        const bi = Number.parseInt(b[0].split(':')[1], 10);
        return ai - bi;
      })
      .map(([, v]) => v);
    if (emKeyValues.length) return emKeyValues;
  }

  const candidates = [
    result && result.em,
    result && result.status,
    result && result.em && result.em.status,
    result && result.status && result.status.em,
    result && result.channels,
    result && result.em && result.em.channels,
    result && result.status && result.status.channels,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (Array.isArray(candidate)) return candidate;
    if (looksLikeChannelStatus(candidate)) return [candidate];

    if (typeof candidate === 'object') {
      const values = Object.values(candidate);
      const out = [];

      for (const value of values) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (looksLikeChannelStatus(item)) out.push(item);
          }
          continue;
        }
        if (looksLikeChannelStatus(value)) out.push(value);
      }

      if (out.length) return out;
    }
  }

  return [];
}

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTemperatureValue(value) {
  const n = toNumberOrNull(value);
  if (n === null) return null;
  const abs = Math.abs(n);

  // Common firmware scales: deci/centi/milli-degrees.
  if (abs > 10000) return n / 1000;
  if (abs > 1000)  return n / 100;
  if (abs > 200)   return n / 10;
  return n;
}

function extractTempByKeySearch(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const preferredKeys = Object.keys(obj).filter(k => /(temperature|temp|tmp|t_c|t_f)/i.test(k));
  for (const key of preferredKeys) {
    const value = normalizeTemperatureValue(obj[key]);
    if (value !== null && value > -80 && value < 200) return value;
  }
  return null;
}

function collectConfigEntries(obj, out, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return;

  if (Array.isArray(obj)) {
    for (const item of obj) collectConfigEntries(item, out, depth + 1);
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(obj, 'id');
  if (hasId) out.push(obj);

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') collectConfigEntries(value, out, depth + 1);
  }
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
    // Refoss uses JSON-RPC 2.0 over HTTP — wrap params in the standard envelope.
    const rpcBody = {
      id:     1,
      src:    'homey-refoss',
      method: path,
      params: body || {},
    };
    const payload = JSON.stringify(rpcBody);

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
    return this._get('Refoss.DeviceInfo.Get');
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
    // This model/firmware reports live EM data reliably via Refoss.Status.Get.
    // Em.Status.Get may return zeroed values.
    return this._get('Refoss.Status.Get');
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

  async getCircuitFactorSnapshot(channelId) {
    const cid = Number.parseInt(channelId, 10);
    if (!Number.isFinite(cid) || cid <= 0) return null;

    // Prefer channel-specific query for verification to avoid stale/ambiguous bulk config parsing.
    let cfgObj = null;
    try {
      const direct = await this._get(`Em.Config.Get?id=${cid}`);
      cfgObj = (direct && direct.result) ? direct.result : direct;
    } catch (_) {
      // Fallback to bulk query when channel-specific endpoint is unavailable.
      const bulk = await this.getEmConfig();
      cfgObj = (bulk && bulk.result) ? bulk.result : bulk;
    }

    const entries = [];
    collectConfigEntries(cfgObj, entries);
    let target = entries.find((entry) => {
      const entryId = Number.parseInt(entry.id ?? entry.cid ?? entry.channelId ?? entry.channel, 10);
      return entryId === cid;
    });
    // If direct query returned a single object without explicit id, use it.
    if (!target && cfgObj && typeof cfgObj === 'object' && !Array.isArray(cfgObj)) {
      target = cfgObj;
    }
    if (!target || typeof target !== 'object') return null;

    const factorFields = {};
    for (const [key, value] of Object.entries(target)) {
      if (/(coef|coeff|factor|multiple|ratio|calib|coefficient|reverse|reversed)/i.test(key)) {
        factorFields[key] = value;
      }
    }
    return {
      id: target.id ?? target.cid ?? target.channelId ?? target.channel ?? cid,
      factorFields,
      raw: target,
    };
  }

  // ---------------------------------------------------------------------------
  // Circuit factor (coefficient) update on device firmware.
  // Firmware fields differ across revisions; this method probes likely keys and
  // method names, then applies the first successful write.
  // ---------------------------------------------------------------------------

  async setCircuitFactor(channelId, factor, options = {}) {
    const cid = Number.parseInt(channelId, 10);
    const value = Number(factor);
    const requireVerify = options.requireVerify === true;
    if (!Number.isFinite(cid) || cid <= 0) throw new Error('Invalid channel id for circuit factor');
    if (!Number.isFinite(value) || Math.abs(value) < 0.5 || Math.abs(value) > 3) {
      throw new Error('Circuit factor must be between -3 and -0.5, or 0.5 and 3');
    }

    // Device firmware only stores the magnitude — it does not support a `reverse`
    // field. The sign (CT clamp direction) is handled entirely in Homey by storing
    // the signed circuit_factor in device settings and applying it when reading
    // power/current values. We only send abs(factor) to the device.
    const absFactor = Math.abs(value);

    const startedAt = Date.now();
    const MAX_TOTAL_MS = requireVerify ? 3800 : 2200;
    const errors = [];
    const formatErr = (e) => String((e && e.message) || e || 'Unknown error').slice(0, 200);
    const factorMatches = (snapshot, target) => {
      if (!snapshot || !snapshot.factorFields) return false;
      const epsilon = 0.011;
      // Match on magnitude only — the sign is a Homey-side setting, not stored on device.
      const absTarget = Math.abs(target);
      const values = Object.values(snapshot.factorFields)
        .map((v) => Math.abs(Number(v)))
        .filter((v) => Number.isFinite(v));
      return values.some((v) => Math.abs(v - absTarget) <= epsilon);
    };
    const verifyApplied = async (delayMs = 150) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const snapshot = await this.getCircuitFactorSnapshot(cid).catch(() => null);
      return { ok: factorMatches(snapshot, value), snapshot };
    };

    // Keep attempts minimal to avoid Homey settings UI timeout.
    const attempts = [
      { method: 'Em.Config.Set', params: { id: cid, factor: absFactor }, key: 'factor', transport: 'ws' },
      { method: 'Em.Config.Set', params: { id: 65535, em: [{ id: cid, factor: absFactor }] }, key: 'factor', transport: 'ws' },
    ];

    for (const attempt of attempts) {
      if (Date.now() - startedAt > MAX_TOTAL_MS) {
        errors.push(`aborted due to timeout budget (${MAX_TOTAL_MS}ms)`);
        break;
      }
      try {
        let response;
        if (attempt.transport === 'ws') {
          response = await this._wsRpc(attempt.method, attempt.params, 1400);
        } else {
          response = await this._post(attempt.method, attempt.params);
        }
        if (!requireVerify) {
          return {
            method: attempt.method,
            key: attempt.key,
            transport: attempt.transport,
            params: attempt.params,
            response,
            verified: false,
          };
        }

        let verify = await verifyApplied(120);
        if (!verify.ok) verify = await verifyApplied(280);
        if (verify.ok) {
          return {
            method: attempt.method,
            key: attempt.key,
            transport: attempt.transport,
            params: attempt.params,
            response,
            verified: true,
            snapshot: verify.snapshot,
          };
        }
        errors.push(`${attempt.method} ${attempt.transport} ${attempt.key}: accepted but readback did not match`);
      } catch (err) {
        errors.push(`${attempt.method} ${attempt.transport} ${attempt.key}: ${formatErr(err)}`);
      }
    }

    throw new Error(`Failed to set circuit factor on device (channel ${cid}): ${errors.slice(0, 8).join(' | ')}`);
  }

  // ---------------------------------------------------------------------------
  // WebSocket JSON-RPC 2.0 call (raw, no external deps)
  //
  // The Refoss device accepts WebSocket connections at ws://<ip>/rpc
  // and uses JSON-RPC 2.0 framing. Webhook.Create only works over WebSocket —
  // the HTTP POST endpoint rejects it with "There is an error. Try it again."
  // ---------------------------------------------------------------------------

  async _wsRpc(method, params, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let done = false;

      // Send a clean WebSocket close frame then destroy after a short drain.
      // Using abrupt socket.destroy() without a close frame can leave the device's
      // TCP connection table in a half-open state, blocking further HTTP connections.
      const closeAndFinish = (socket, cb) => {
        if (socket.destroyed) { cb(); return; }
        // RFC 6455 close frame: FIN=1 opcode=8, masked, no payload
        const mask = crypto.randomBytes(4);
        socket.write(Buffer.from([0x88, 0x80, mask[0], mask[1], mask[2], mask[3]]), () => {
          // Give device 200 ms to echo the close frame back, then tear down
          setTimeout(() => { socket.destroy(); cb(); }, 200);
        });
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        closeAndFinish(socket, () => {});
        reject(new Error(`WebSocket RPC timeout calling ${method}`));
      }, timeoutMs);

      const socket = net.createConnection({ host: this.ipAddress, port: 80 }, () => {
        // WebSocket opening handshake
        const key   = crypto.randomBytes(16).toString('base64');
        const reqId = Math.floor(Math.random() * 65536);

        const handshake = [
          'GET /rpc HTTP/1.1',
          `Host: ${this.ipAddress}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n');
        socket.write(handshake);

        let buf             = Buffer.alloc(0);
        let wsHandshakeDone = false;
        let framePayload    = '';

        socket.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);

          if (!wsHandshakeDone) {
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;   // still reading HTTP upgrade headers
            wsHandshakeDone = true;
            buf = buf.slice(headerEnd + 4); // strip HTTP headers, keep any leftover WS data

            // Send the JSON-RPC request as a masked WebSocket text frame
            const msg    = JSON.stringify({ id: reqId, src: 'homey', method, params: params || {} });
            const msgBuf = Buffer.from(msg);
            const mask   = crypto.randomBytes(4);
            const len    = msgBuf.length;

            let header;
            if (len < 126) {
              header = Buffer.from([0x81, 0x80 | len]);
            } else if (len < 65536) {
              header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);
            } else {
              header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0,
                (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
            }
            const masked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) masked[i] = msgBuf[i] ^ mask[i % 4];
            socket.write(Buffer.concat([header, mask, masked]));
          }

          // Parse incoming WebSocket frames
          while (buf.length >= 2) {
            const b0        = buf[0];
            const b1        = buf[1];
            const isMasked  = (b1 & 0x80) !== 0;
            let payLen      = b1 & 0x7f;
            let offset      = 2;

            if (payLen === 126) {
              if (buf.length < 4) return;
              payLen = (buf[2] << 8) | buf[3];
              offset = 4;
            } else if (payLen === 127) {
              if (buf.length < 10) return;
              payLen = (buf[6] << 24) | (buf[7] << 16) | (buf[8] << 8) | buf[9];
              offset = 10;
            }

            const maskBytes = isMasked ? 4 : 0;
            if (buf.length < offset + maskBytes + payLen) return; // incomplete frame

            let payload = buf.slice(offset + maskBytes, offset + maskBytes + payLen);
            if (isMasked) {
              const m = buf.slice(offset, offset + 4);
              payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4]));
            }
            buf = buf.slice(offset + maskBytes + payLen);

            const opcode = b0 & 0x0f;

            if (opcode === 0x01 || opcode === 0x00) { // text / continuation frame
              framePayload += payload.toString('utf8');
              if ((b0 & 0x80) !== 0) { // FIN bit — complete message
                let parsed;
                try { parsed = JSON.parse(framePayload); } catch (_) { framePayload = ''; continue; }
                framePayload = '';

                if (parsed.id !== reqId) continue; // not our response (could be a push)
                if (done) return;
                done = true;
                clearTimeout(timer);

                if (parsed.error) {
                  closeAndFinish(socket, () => {});
                  return reject(new Error(`WS RPC error ${parsed.error.code}: ${parsed.error.message}`));
                }
                closeAndFinish(socket, () => {});
                return resolve(parsed.result);
              }
            } else if (opcode === 0x08) { // close frame from device
              if (done) return;
              done = true;
              clearTimeout(timer);
              socket.destroy();
              return reject(new Error('WebSocket closed by device'));
            } else if (opcode === 0x09) { // ping — reply with masked pong
              const pm = crypto.randomBytes(4);
              socket.write(Buffer.from([0x8a, 0x80, pm[0], pm[1], pm[2], pm[3]]));
            }
            // opcode 0x0a (pong) — ignore
          }
        });
      });

      socket.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(`WebSocket connection error: ${err.message}`));
      });
    });
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

  async createWebhook({ name, event, urls, cid, repeatPeriod = 0 }) {
    // Webhook.Create requires WebSocket JSON-RPC 2.0 — the HTTP GET endpoint
    // returns "string parse error" because the firmware's query-string parser cannot
    // handle the JSON array value for `urls`. HTTP POST also fails with
    // "There is an error. Try it again." The aiorefoss reference library uses
    // WebSocket exclusively for all RPC calls, which is the correct approach.
    const urlsArr = Array.isArray(urls) ? urls : [urls];
    const params  = {
      name,
      event,
      enable: true,
      urls:   urlsArr,
      repeat_period: repeatPeriod,
    };
    if (cid !== undefined) params.cid = cid;
    return this._wsRpc('Webhook.Create', params);
  }

  async deleteWebhook(id) {
    // Prefer WebSocket for mutations; fall back to GET if WS fails
    try {
      return await this._wsRpc('Webhook.Delete', { id });
    } catch (_) {
      return this._get(`Webhook.Delete?id=${id}`);
    }
  }

  async deleteAllWebhooks() {
    try {
      return await this._wsRpc('Webhook.DeleteAll', {});
    } catch (_) {
      return this._get('Webhook.DeleteAll');
    }
  }

  // ---------------------------------------------------------------------------
  // Register the Homey webhook — idempotent:
  //   1. List existing webhooks.
  //   2. Delete any stale Homey webhooks (name matches ours).
  //   3. Create a fresh webhook pointing at homeyUrl.
  //
  // Returns the created webhook id.
  // ---------------------------------------------------------------------------

  async registerHomeyWebhook(homeyUrl, emEvent, options = {}) {
    const HOOK_NAME = 'homeyrefoss'; // no hyphens — some firmware parsers reject them
    const channelIds = Array.isArray(options.channelIds) ? options.channelIds : [];

    // Remove any previously registered Homey webhooks for this device
    try {
      const listResp = await this.listWebhooks();
      const hooks = (listResp.result && listResp.result.hooks)
        || listResp.hooks
        || [];
      for (const hook of hooks) {
        if (
          hook.name === HOOK_NAME
          || hook.name === 'homey-refoss'
          || (typeof hook.name === 'string' && hook.name.startsWith(`${HOOK_NAME}c`))
        ) {
          await this.deleteWebhook(hook.id).catch(() => {});
        }
      }
    } catch (_) {
      // If listing fails, proceed anyway and try to create
    }

    // Official docs: cid is required. For emmerge.* aggregate events, cid=1 is used
    // (the device fires for all channels). For em.* per-channel events, cid=1 means ch1 only.
    // Try emmerge first (fires for all channels), then em with cid=1 as fallback.
    const isPerChannel = emEvent.startsWith('em.') && !emEvent.startsWith('emmerge.');
    const mergeEvent   = isPerChannel ? emEvent.replace(/^em\./, 'emmerge.') : emEvent;

    const attempts = [
      { event: mergeEvent, cid: 1 },   // emmerge.power_change — aggregate, fires for all channels
      { event: emEvent,    cid: 1 },   // em.power_change ch1 — fallback
    ];

    let lastErr;
    for (const attempt of attempts) {
      try {
        const resp   = await this.createWebhook({
          name: HOOK_NAME,
          event: attempt.event,
          cid:   attempt.cid,
          urls: [homeyUrl],
          repeatPeriod: 0,
        });
        const result = resp.result || resp;
        const primaryId = result.id;

        // Some firmware versions accept emmerge.* registration but do not deliver
        // callbacks. Also register per-channel em.power_change hooks so CT changes
        // trigger push updates reliably.
        const perChannelEvent = emEvent.startsWith('emmerge.')
          ? emEvent.replace(/^emmerge\./, 'em.')
          : emEvent;
        const perChannelIds = [...new Set(channelIds
          .map(id => Number.parseInt(id, 10))
          .filter(id => Number.isFinite(id) && id > 0))];

        let perChannelCreated = 0;
        let perChannelFailed = 0;
        const perChannelErrors = [];
        if (perChannelEvent.startsWith('em.') && perChannelIds.length > 1) {
          for (const cid of perChannelIds) {
            try {
              await this.createWebhook({
                name: `${HOOK_NAME}c${cid}`,
                event: perChannelEvent,
                cid,
                urls: [homeyUrl],
                repeatPeriod: 0,
              });
              perChannelCreated++;
            } catch (_) {
              perChannelFailed++;
              if (perChannelErrors.length < 5) {
                perChannelErrors.push(`cid=${cid}`);
              }
            }
          }
        }

        return {
          id: primaryId,
          perChannel: {
            requested: perChannelIds.length,
            created: perChannelCreated,
            failed: perChannelFailed,
            errors: perChannelErrors,
          },
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------------------
  // Remove any Homey-registered webhooks from the device
  // ---------------------------------------------------------------------------

  async unregisterHomeyWebhook() {
    const HOOK_NAME = 'homeyrefoss';
    try {
      const listResp = await this.listWebhooks();
      const hooks = (listResp.result && listResp.result.hooks)
        || listResp.hooks
        || [];
      for (const hook of hooks) {
        if (
          hook.name === HOOK_NAME
          || hook.name === 'homey-refoss'
          || (typeof hook.name === 'string' && hook.name.startsWith(`${HOOK_NAME}c`))
        ) {
          await this.deleteWebhook(hook.id).catch(() => {});
        }
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Best-effort diagnostics for webhook failures
  // ---------------------------------------------------------------------------

  async getWebhookDiagnostics() {
    const out = {};
    try {
      const supported = await this.getSupportedWebhookEvents();
      out.supported = supported;
    } catch (err) {
      out.supported_error = err.message;
    }

    try {
      const list = await this.listWebhooks();
      out.list = list;
    } catch (err) {
      out.list_error = err.message;
    }

    return out;
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
    const result = (raw && typeof raw === 'object')
      ? ((raw.result && typeof raw.result === 'object') ? raw.result : raw)
      : {};

    // Firmware variants wrap channel data differently; normalize to one array.
    const statusArray = normalizeStatusArray(result);

    const map = {};
    let totalPower   = 0;
    let totalCurrent = 0;

    // Device-level temperature — various locations depending on firmware/method:
    //   Refoss.Status.Get: result.sys.temperature or result.temperature
    //   Em.Status.Get:     result.temperature
    const tempCandidates = [
      result.temperature,
      result.temp,
      result.tmp,
      result.sys && result.sys.temperature,
      result.sys && result.sys.temp,
      result.sys && result.sys.tmp,
      result.sys && result.sys.t,
      extractTempByKeySearch(result.sys),
      extractTempByKeySearch(result),
    ];
    const temp = tempCandidates
      .map(normalizeTemperatureValue)
      .find(v => v !== null && v > -80 && v < 200) ?? null;
    map.temperature = temp;

    for (let index = 0; index < statusArray.length; index++) {
      const ch = statusArray[index];
      // Apparent power: use apower field if present, otherwise derive from power / pf
      const apower = ch.apower !== undefined
        ? ch.apower
        : (ch.power !== undefined && ch.pf != null && ch.pf !== 0)
          ? ch.power / ch.pf
          : null;

      const entry = {
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

      // Keep a stable numeric index (1-based) regardless of firmware id format.
      // Some firmwares return id as non-numeric labels, while Homey channel ids
      // are configured as 1..N.
      map[index + 1] = entry;

      // Also expose by raw id, when present.
      if (ch.id !== undefined && ch.id !== null) {
        map[ch.id] = entry;
        if (typeof ch.id === 'string') {
          map[ch.id.toLowerCase()] = entry;
          const numericId = Number.parseInt(ch.id, 10);
          if (!Number.isNaN(numericId)) map[numericId] = entry;
        }
      }

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
      const method = parsed && parsed.method;

      const params = parsed.params || {};
      const em     = params.em || params.emmerge || null;
      if (!em) return null;

      // Apparent power: use apower field if present, otherwise derive from power / pf
      const apower = em.apower !== undefined
        ? em.apower
        : (em.power !== undefined && em.pf != null && em.pf !== 0)
          ? em.power / em.pf
          : null;

      const channelId = em.id !== undefined && em.id !== null
        ? (Number.isNaN(Number.parseInt(em.id, 10)) ? em.id : Number.parseInt(em.id, 10))
        : null;

      return {
        method: method || null,
        channelId,
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
