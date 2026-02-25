'use strict';

const Homey = require('homey');
const RefossApi = require('../../lib/RefossApi');

// Channel sub-devices for EM06P and EM16P.
// Each instance handles one CT transformer identified by integer channelId (1-based).
//
// Push path (primary):
//   The parent device (em06p/em16p) registers a webhook on the Refoss device.
//   The app-level webhook server receives the POST and dispatches by MAC.
//   The app's channel handler map then routes to the correct channel device by channelId.
//
// Poll path (fallback / safety net):
//   A 60-second slow poll runs in parallel to catch any missed pushes.

const FALLBACK_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_POLL_INTERVAL_S   = 10;
const MIN_POLL_INTERVAL_S       = 5;

class EmChannelDevice extends Homey.Device {

  async onInit() {
    this.log(`EmChannelDevice initialized: ${this.getName()}`);

    // Immutable identity stored in device data
    this._channelId   = this.getData().channelId;   // integer, 1-based
    this._deviceMac   = this.getData().deviceMac;   // parent MAC, uppercase no colons
    this._deviceModel = this.getData().deviceModel; // 'em06p' | 'em16p'

    // Mutable settings
    this._ipAddress   = this.getSetting('ip_address') || this.getStoreValue('ip_address');
    this._username    = this.getSetting('username') || null;
    this._password    = this.getSetting('password') || null;
    this._pollInterval = Math.max(MIN_POLL_INTERVAL_S, this.getSetting('poll_interval') || DEFAULT_POLL_INTERVAL_S) * 1000;
    this._api         = new RefossApi(this._ipAddress, this._username, this._password);

    // Register with the app so webhook pushes are routed here by channelId
    this.homey.app.registerChannelHandler(this._deviceMac, this._channelId, (data) => {
      this._onWebhookData(data).catch(err => this.error('Webhook data error:', err.message));
    });

    // Initial poll to populate values immediately
    await this._pollDevice().catch(err => this.error('Initial poll failed:', err.message));

    // Slow fallback poll — webhook is registered by the parent (em06p/em16p) device
    this._startPolling(FALLBACK_POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Helper: set capability and fire relevant triggers if value changed
  // ---------------------------------------------------------------------------

  async _updateCapability(cap, newValue) {
    if (newValue == null) return;
    const oldValue = this.getCapabilityValue(cap);
    await this.setCapabilityValue(cap, newValue);

    // Only fire triggers on actual value change to avoid flooding
    if (newValue === oldValue) return;

    const app = this.homey.app;
    if (cap === 'measure_power')    app.triggerPowerChanged(this, newValue).catch(() => {});
    if (cap === 'meter_power')      app.triggerMonthEnergy(this, newValue).catch(() => {});
    if (cap === 'meter_power_week') app.triggerWeekEnergy(this, newValue).catch(() => {});
    if (cap === 'meter_power_day')  app.triggerDayEnergy(this, newValue).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Called by app when a NotifyStatus push arrives for this channel
  // data = { channelId, power, voltage, current, pf, monthEnergy, ... }
  // ---------------------------------------------------------------------------

  async _onWebhookData(data) {
    if (data && data.power === 0) {
      // Some webhook payloads report power=0 but omit apparent/current/pf.
      // Force these to zero to avoid stale non-zero UI values.
      if (data.apparentPower == null) data.apparentPower = 0;
      if (data.current == null) data.current = 0;
      if (data.pf == null) data.pf = 0;
    }

    const updates = [];
    if (data.power           != null) updates.push(this._updateCapability('measure_power',           data.power));
    if (data.voltage         != null) updates.push(this._updateCapability('measure_voltage',         data.voltage));
    if (data.current         != null) updates.push(this._updateCapability('measure_current',         data.current));
    if (data.monthEnergy     != null) updates.push(this._updateCapability('meter_power',             data.monthEnergy));
    if (data.apparentPower   != null) updates.push(this._updateCapability('measure_apparent_power',  data.apparentPower));
    if (data.pf              != null) updates.push(this._updateCapability('measure_power_factor',    data.pf));
    if (data.weekEnergy      != null) updates.push(this._updateCapability('meter_power_week',        data.weekEnergy));
    if (data.dayEnergy       != null) updates.push(this._updateCapability('meter_power_day',         data.dayEnergy));
    if (data.monthRetEnergy  != null) updates.push(this._updateCapability('meter_power.exported',    data.monthRetEnergy));

    await Promise.all(updates).catch(err => this.error('Capability update error:', err.message));
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Fallback polling
  // ---------------------------------------------------------------------------

  _startPolling(intervalMs) {
    this._stopPolling();
    this._pollTimer = this.homey.setInterval(
      () => this._pollDevice().catch(err => this.error('Poll error:', err.message)),
      intervalMs
    );
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _pollDevice() {
    try {
      const raw       = await this._api.getEmStatus();
      const statusMap = RefossApi.parseEmStatus(raw);
      const ch        = statusMap[this._channelId];

      if (!ch) throw new Error(`Channel ${this._channelId} not found in response`);

      const updates = [];
      if (ch.power           != null) updates.push(this._updateCapability('measure_power',           ch.power));
      if (ch.voltage         != null) updates.push(this._updateCapability('measure_voltage',         ch.voltage));
      if (ch.current         != null) updates.push(this._updateCapability('measure_current',         ch.current));
      if (ch.monthEnergy     != null) updates.push(this._updateCapability('meter_power',             ch.monthEnergy));
      if (ch.apparentPower   != null) updates.push(this._updateCapability('measure_apparent_power',  ch.apparentPower));
      if (ch.pf              != null) updates.push(this._updateCapability('measure_power_factor',    ch.pf));
      if (ch.weekEnergy      != null) updates.push(this._updateCapability('meter_power_week',        ch.weekEnergy));
      if (ch.dayEnergy       != null) updates.push(this._updateCapability('meter_power_day',         ch.dayEnergy));
      if (ch.monthRetEnergy  != null) updates.push(this._updateCapability('meter_power.exported',    ch.monthRetEnergy));

      await Promise.all(updates);
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error(`Poll failed for channel ${this._channelId}:`, err.message);
      if (this.getAvailable())
        await this.setUnavailable(this.homey.__('device.unreachable')).catch(() => {});
    }
  }

  async onSettings({ newSettings }) {
    let apiChanged = false;

    if (newSettings.ip_address !== undefined && newSettings.ip_address !== this._ipAddress) {
      this._ipAddress = newSettings.ip_address;
      apiChanged = true;
    }
    if (newSettings.username !== undefined) {
      const nextUsername = newSettings.username || null;
      if (nextUsername !== this._username) {
        this._username = nextUsername;
        apiChanged = true;
      }
    }
    if (newSettings.password !== undefined) {
      const nextPassword = newSettings.password || null;
      if (nextPassword !== this._password) {
        this._password = nextPassword;
        apiChanged = true;
      }
    }
    if (newSettings.poll_interval !== undefined) {
      this._pollInterval = Math.max(MIN_POLL_INTERVAL_S, newSettings.poll_interval) * 1000;
    }

    if (apiChanged) {
      this._api = new RefossApi(this._ipAddress, this._username, this._password);
    }

    this._startPolling(FALLBACK_POLL_INTERVAL_MS);
  }

  async onDeleted() {
    this.log(`EmChannelDevice deleted: ${this.getName()}`);
    this._stopPolling();
    this.homey.app.unregisterChannelHandler(this._deviceMac, this._channelId);
  }

}

module.exports = EmChannelDevice;
