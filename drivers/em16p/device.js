'use strict';

const Homey = require('homey');
const RefossApi = require('../../lib/RefossApi');

const FALLBACK_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_POLL_INTERVAL_S   = 10;
const MIN_POLL_INTERVAL_S       = 5;

class Em16pDevice extends Homey.Device {

  async onInit() {
    this.log(`Em16pDevice initialized: ${this.getName()}`);

    this._mac           = this.getData().mac;
    this._ipAddress     = this.getStoreValue('ip_address') || this.getSetting('ip_address');
    this._pollInterval  = Math.max(MIN_POLL_INTERVAL_S, this.getSetting('poll_interval') || DEFAULT_POLL_INTERVAL_S) * 1000;
    this._api           = new RefossApi(this._ipAddress);
    this._webhookId     = null;
    this._webhookActive = false;

    await this._pollDevice().catch(err => this.error('Initial poll failed:', err.message));
    await this._setupWebhook();
  }

  async _setupWebhook() {
    this._stopPolling();
    try {
      const emEvent    = await this._resolveEmEvent();
      const webhookUrl = await this.homey.app.getWebhookUrl(this._mac);

      this.homey.app.registerWebhookHandler(this._mac, (data) => {
        this._onWebhookData(data).catch(err => this.error('Webhook handler error:', err.message));
      });

      this._webhookId     = await this._api.registerHomeyWebhook(webhookUrl, emEvent);
      this._webhookActive = true;
      this.log(`Webhook registered (id=${this._webhookId}) for ${this.getName()}`);
      this._startPolling(FALLBACK_POLL_INTERVAL_MS);
    } catch (err) {
      this.error(`Webhook setup failed, falling back to polling: ${err.message}`);
      this._webhookActive = false;
      this._startPolling(this._pollInterval);
    }
  }

  async _resolveEmEvent() {
    try {
      const resp  = await this._api.getSupportedWebhookEvents();
      const types = (resp.result && resp.result.types) || {};
      const emKey = Object.keys(types).find(k => k.startsWith('em.'));
      if (emKey) return emKey;
    } catch (_) {}
    return RefossApi.EM_WEBHOOK_EVENT;
  }

  async _teardownWebhook() {
    this.homey.app.unregisterWebhookHandler(this._mac);
    if (this._webhookActive) {
      await this._api.unregisterHomeyWebhook().catch(() => {});
      this._webhookActive = false;
      this._webhookId     = null;
    }
  }

  // Helper: set capability and fire relevant triggers if value changed
  async _updateCapability(cap, newValue) {
    if (newValue == null) return;
    const oldValue = this.getCapabilityValue(cap);
    await this.setCapabilityValue(cap, newValue);

    if (newValue === oldValue) return;

    const app = this.homey.app;
    if (cap === 'measure_power')    app.triggerPowerChanged(this, newValue).catch(() => {});
    if (cap === 'meter_power')      app.triggerMonthEnergy(this, newValue).catch(() => {});
    if (cap === 'meter_power_week') app.triggerWeekEnergy(this, newValue).catch(() => {});
    if (cap === 'meter_power_day')  app.triggerDayEnergy(this, newValue).catch(() => {});
  }

  async _onWebhookData(data) {
    await this._pollDevice().catch(err => this.error('Post-webhook poll failed:', err.message));
  }

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
      const updates   = [];

      if (statusMap.total.power !== null)
        updates.push(this._updateCapability('measure_power', statusMap.total.power));
      if (statusMap.total.current !== null)
        updates.push(this._updateCapability('measure_current', statusMap.total.current));

      const ch1 = statusMap[1];
      if (ch1 && ch1.voltage !== null)
        updates.push(this._updateCapability('measure_voltage', ch1.voltage));

      let totalKwh  = 0, hasEnergy   = false;
      let totalWkh  = 0, hasWeek    = false;
      let totalDkh  = 0, hasDay     = false;
      let totalVA   = 0, hasVA      = false;
      let totalRKwh = 0, hasREnergy = false;
      let totalRWkh = 0, hasRWeek   = false;
      let totalRDkh = 0, hasRDay    = false;
      for (const ch of RefossApi.EM16P_CHANNELS) {
        const entry = statusMap[ch.id];
        if (entry && entry.monthEnergy    !== null) { totalKwh  += entry.monthEnergy;    hasEnergy   = true; }
        if (entry && entry.weekEnergy     !== null) { totalWkh  += entry.weekEnergy;     hasWeek     = true; }
        if (entry && entry.dayEnergy      !== null) { totalDkh  += entry.dayEnergy;      hasDay      = true; }
        if (entry && entry.apparentPower  !== null) { totalVA   += entry.apparentPower;  hasVA       = true; }
        if (entry && entry.monthRetEnergy !== null) { totalRKwh += entry.monthRetEnergy; hasREnergy  = true; }
        if (entry && entry.weekRetEnergy  !== null) { totalRWkh += entry.weekRetEnergy;  hasRWeek    = true; }
        if (entry && entry.dayRetEnergy   !== null) { totalRDkh += entry.dayRetEnergy;   hasRDay     = true; }
      }
      if (hasEnergy)   updates.push(this._updateCapability('meter_power',               totalKwh));
      if (hasWeek)     updates.push(this._updateCapability('meter_power_week',           totalWkh));
      if (hasDay)      updates.push(this._updateCapability('meter_power_day',            totalDkh));
      if (hasVA)       updates.push(this._updateCapability('measure_apparent_power',     totalVA));
      if (hasREnergy)  updates.push(this._updateCapability('meter_power_exported',       totalRKwh));
      if (hasRWeek)    updates.push(this._updateCapability('meter_power_exported_week',  totalRWkh));
      if (hasRDay)     updates.push(this._updateCapability('meter_power_exported_day',   totalRDkh));

      if (ch1 && ch1.pf !== null)
        updates.push(this._updateCapability('measure_power_factor', ch1.pf));

      await Promise.all(updates);
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll failed:', err.message);
      if (this.getAvailable())
        await this.setUnavailable(this.homey.__('device.unreachable')).catch(() => {});
    }
  }

  async onSettings({ newSettings }) {
    if (newSettings.ip_address && newSettings.ip_address !== this._ipAddress) {
      this._ipAddress = newSettings.ip_address;
      this._api = new RefossApi(this._ipAddress);
      await this.setStoreValue('ip_address', this._ipAddress);
    }
    if (newSettings.poll_interval)
      this._pollInterval = Math.max(MIN_POLL_INTERVAL_S, newSettings.poll_interval) * 1000;
    await this._teardownWebhook();
    await this._setupWebhook();
  }

  async onDeleted() {
    this.log(`Em16pDevice deleted: ${this.getName()}`);
    this._stopPolling();
    await this._teardownWebhook();
  }

}

module.exports = Em16pDevice;
