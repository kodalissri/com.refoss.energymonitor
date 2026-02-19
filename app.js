'use strict';

const Homey = require('homey');
const http  = require('http');
const RefossApi = require('./lib/RefossApi');

// Port the local HTTP server listens on for incoming webhook POSTs from devices.
// Must be reachable from the Refoss device on the LAN.
// Homey Pro's local IP is used as the webhook target host.
const WEBHOOK_PORT = 8741;

class RefossApp extends Homey.App {

  async onInit() {
    this.log('Refoss Energy Monitor app started');

    // Map of deviceMac -> callback function, registered by device instances
    this._webhookHandlers = new Map();

    await this._startWebhookServer();
    this._registerFlowCards();
  }

  // ---------------------------------------------------------------------------
  // Flow card registration
  //
  // Condition cards: run-time checks (is value above/below/between threshold?)
  // Trigger cards:   fired by device instances when a value changes
  // ---------------------------------------------------------------------------

  _registerFlowCards() {

    // ---- CONDITION cards ----------------------------------------------------

    const conditions = [
      // Power
      { id: 'measure_power_above',    cap: 'measure_power',          check: (v, a) => v > a.threshold },
      { id: 'measure_power_below',    cap: 'measure_power',          check: (v, a) => v < a.threshold },
      { id: 'measure_power_between',  cap: 'measure_power',          check: (v, a) => v >= a.low && v <= a.high },
      // Voltage
      { id: 'measure_voltage_above',   cap: 'measure_voltage',       check: (v, a) => v > a.threshold },
      { id: 'measure_voltage_below',   cap: 'measure_voltage',       check: (v, a) => v < a.threshold },
      { id: 'measure_voltage_between', cap: 'measure_voltage',       check: (v, a) => v >= a.low && v <= a.high },
      // Current
      { id: 'measure_current_above',   cap: 'measure_current',       check: (v, a) => v > a.threshold },
      { id: 'measure_current_below',   cap: 'measure_current',       check: (v, a) => v < a.threshold },
      { id: 'measure_current_between', cap: 'measure_current',       check: (v, a) => v >= a.low && v <= a.high },
      // Monthly energy
      { id: 'meter_power_above',       cap: 'meter_power',           check: (v, a) => v > a.threshold },
      { id: 'meter_power_below',       cap: 'meter_power',           check: (v, a) => v < a.threshold },
      { id: 'meter_power_between',     cap: 'meter_power',           check: (v, a) => v >= a.low && v <= a.high },
      // Weekly energy
      { id: 'meter_power_week_above',   cap: 'meter_power_week',     check: (v, a) => v > a.threshold },
      { id: 'meter_power_week_below',   cap: 'meter_power_week',     check: (v, a) => v < a.threshold },
      { id: 'meter_power_week_between', cap: 'meter_power_week',     check: (v, a) => v >= a.low && v <= a.high },
      // Daily energy
      { id: 'meter_power_day_above',    cap: 'meter_power_day',      check: (v, a) => v > a.threshold },
      { id: 'meter_power_day_below',    cap: 'meter_power_day',      check: (v, a) => v < a.threshold },
      { id: 'meter_power_day_between',  cap: 'meter_power_day',      check: (v, a) => v >= a.low && v <= a.high },
      // Power factor
      { id: 'measure_power_factor_above', cap: 'measure_power_factor', check: (v, a) => v > a.threshold },
      { id: 'measure_power_factor_below', cap: 'measure_power_factor', check: (v, a) => v < a.threshold },
    ];

    for (const { id, cap, check } of conditions) {
      this.homey.flow.getConditionCard(id)
        .registerRunListener(async ({ device, ...args }) => {
          const value = await device.getCapabilityValue(cap);
          if (value == null) return false;
          return check(value, args);
        });
    }

    // ---- TRIGGER cards ------------------------------------------------------
    // Trigger cards are fired from device instances via this.homey.app.triggerXxx()
    // We store references so devices can call .trigger(device, tokens, state)

    this._triggerPowerChanged = this.homey.flow.getDeviceTriggerCard('measure_power_changed');
    this._triggerPowerAbove   = this.homey.flow.getDeviceTriggerCard('measure_power_above');
    this._triggerPowerBelow   = this.homey.flow.getDeviceTriggerCard('measure_power_below');
    this._triggerDayAbove     = this.homey.flow.getDeviceTriggerCard('meter_power_day_above');
    this._triggerWeekAbove    = this.homey.flow.getDeviceTriggerCard('meter_power_week_above');
    this._triggerMonthAbove   = this.homey.flow.getDeviceTriggerCard('meter_power_above');

    // The "power rises above / drops below" triggers have a user-defined threshold.
    // We filter so only the card instance whose threshold matches actually fires.
    this._triggerPowerAbove.registerRunListener(async (args, state) => {
      return state.power > args.threshold;
    });
    this._triggerPowerBelow.registerRunListener(async (args, state) => {
      return state.power < args.threshold;
    });
    this._triggerDayAbove.registerRunListener(async (args, state) => {
      return state.energy > args.threshold;
    });
    this._triggerWeekAbove.registerRunListener(async (args, state) => {
      return state.energy > args.threshold;
    });
    this._triggerMonthAbove.registerRunListener(async (args, state) => {
      return state.energy > args.threshold;
    });

    this.log('Flow cards registered');
  }

  // ---------------------------------------------------------------------------
  // Called by device instances to fire trigger cards
  // ---------------------------------------------------------------------------

  async triggerPowerChanged(device, power) {
    await this._triggerPowerChanged
      .trigger(device, { power }, {})
      .catch(err => this.error('triggerPowerChanged error:', err.message));

    await this._triggerPowerAbove
      .trigger(device, { power }, { power })
      .catch(err => this.error('triggerPowerAbove error:', err.message));

    await this._triggerPowerBelow
      .trigger(device, { power }, { power })
      .catch(err => this.error('triggerPowerBelow error:', err.message));
  }

  async triggerDayEnergy(device, energy) {
    await this._triggerDayAbove
      .trigger(device, { energy }, { energy })
      .catch(err => this.error('triggerDayAbove error:', err.message));
  }

  async triggerWeekEnergy(device, energy) {
    await this._triggerWeekAbove
      .trigger(device, { energy }, { energy })
      .catch(err => this.error('triggerWeekAbove error:', err.message));
  }

  async triggerMonthEnergy(device, energy) {
    await this._triggerMonthAbove
      .trigger(device, { energy }, { energy })
      .catch(err => this.error('triggerMonthAbove error:', err.message));
  }

  // ---------------------------------------------------------------------------
  // Start a plain HTTP server that receives NotifyStatus POSTs from Refoss devices.
  //
  // URL path:  POST /webhook/<deviceMac>
  //   deviceMac — MAC address of the Refoss device (uppercase, no colons)
  //
  // The device sends a JSON body like:
  // {
  //   "src": "refoss-em06p-aabbccddeeff",
  //   "method": "NotifyStatus",
  //   "params": { "ts": 1234567890000, "em": { "id": 1, "power": 123.4, ... } }
  // }
  // ---------------------------------------------------------------------------

  async _startWebhookServer() {
    this._webhookServer = http.createServer((req, res) => {
      // Only accept POSTs to /webhook/<mac>
      if (req.method !== 'POST' || !req.url.startsWith('/webhook/')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const mac = req.url.split('/webhook/')[1] || '';

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        // Acknowledge immediately — device doesn't care about the response body
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');

        // Parse the push body
        let parsed = null;
        try {
          parsed = RefossApi.parseNotifyStatus(body);
        } catch (err) {
          this.error(`Webhook parse error for ${mac}:`, err.message);
        }

        if (parsed) {
          // Route to the parent device handler (for aggregate update)
          const deviceHandler = this._webhookHandlers.get(mac.toUpperCase());
          if (deviceHandler) deviceHandler(parsed);

          // Route to the specific channel device handler
          const channelKey = `${mac.toUpperCase()}:${parsed.channelId}`;
          const channelHandler = this._webhookHandlers.get(channelKey);
          if (channelHandler) channelHandler(parsed);
        }
      });
    });

    await new Promise((resolve, reject) => {
      this._webhookServer.listen(WEBHOOK_PORT, '0.0.0.0', (err) => {
        if (err) return reject(err);
        this.log(`Webhook server listening on port ${WEBHOOK_PORT}`);
        resolve();
      });
    }).catch((err) => {
      this.error('Failed to start webhook server:', err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Called by device instances on onInit() to register themselves.
  // mac — uppercase MAC with no colons, e.g. "AABBCCDDEEFF"
  // handler — function(parsedData) called with RefossApi.parseNotifyStatus output
  // ---------------------------------------------------------------------------

  registerWebhookHandler(mac, handler) {
    this._webhookHandlers.set(mac.toUpperCase(), handler);
    this.log(`Webhook handler registered for device ${mac}`);
  }

  unregisterWebhookHandler(mac) {
    this._webhookHandlers.delete(mac.toUpperCase());
    this.log(`Webhook handler unregistered for device ${mac}`);
  }

  // ---------------------------------------------------------------------------
  // Channel-level dispatch — routes a push to the correct em_channel device.
  // Key format: "<MAC>:<channelId>" e.g. "AABBCCDDEEFF:3"
  // ---------------------------------------------------------------------------

  registerChannelHandler(mac, channelId, handler) {
    this._webhookHandlers.set(`${mac.toUpperCase()}:${channelId}`, handler);
  }

  unregisterChannelHandler(mac, channelId) {
    this._webhookHandlers.delete(`${mac.toUpperCase()}:${channelId}`);
  }

  // ---------------------------------------------------------------------------
  // Returns the URL the Refoss device should POST to for this device's mac.
  // Homey Pro's local IP is obtained from this.homey.cloud.getLocalAddress().
  // ---------------------------------------------------------------------------

  async getWebhookUrl(mac) {
    const localAddress = await this.homey.cloud.getLocalAddress();
    return `http://${localAddress}:${WEBHOOK_PORT}/webhook/${mac.toUpperCase()}`;
  }

  get webhookPort() {
    return WEBHOOK_PORT;
  }

  async onUninit() {
    if (this._webhookServer) {
      this._webhookServer.close();
      this.log('Webhook server stopped');
    }
  }

}

module.exports = RefossApp;
