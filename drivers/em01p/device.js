'use strict';

const Homey = require('homey');
const RefossApi = require('../../lib/RefossApi');

const FALLBACK_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_POLL_INTERVAL_S   = 10;
const MIN_POLL_INTERVAL_S       = 5;

class Em01pDevice extends Homey.Device {

  async onInit() {
    this.log(`Em01pDevice initialized: ${this.getName()}`);

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

  // Single-channel device — update capabilities directly from push data
  async _onWebhookData(data) {
    const updates = [];
    if (data.power         != null) updates.push(this._updateCapability('measure_power',          data.power));
    if (data.voltage       != null) updates.push(this._updateCapability('measure_voltage',        data.voltage));
    if (data.current       != null) updates.push(this._updateCapability('measure_current',        data.current));
    if (data.monthEnergy   != null) updates.push(this._updateCapability('meter_power',            data.monthEnergy));
    if (data.apparentPower != null) updates.push(this._updateCapability('measure_apparent_power', data.apparentPower));
    if (data.pf            != null) updates.push(this._updateCapability('measure_power_factor',   data.pf));
    if (data.weekEnergy    != null) updates.push(this._updateCapability('meter_power_week',       data.weekEnergy));
    if (data.dayEnergy     != null) updates.push(this._updateCapability('meter_power_day',        data.dayEnergy));
    await Promise.all(updates).catch(err => this.error('Capability update error:', err.message));
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
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
      const ch        = statusMap[1];
      if (!ch) throw new Error('No channel data in response');

      const updates = [];
      if (ch.power         != null) updates.push(this._updateCapability('measure_power',          ch.power));
      if (ch.voltage       != null) updates.push(this._updateCapability('measure_voltage',        ch.voltage));
      if (ch.current       != null) updates.push(this._updateCapability('measure_current',        ch.current));
      if (ch.monthEnergy   != null) updates.push(this._updateCapability('meter_power',            ch.monthEnergy));
      if (ch.apparentPower != null) updates.push(this._updateCapability('measure_apparent_power', ch.apparentPower));
      if (ch.pf            != null) updates.push(this._updateCapability('measure_power_factor',   ch.pf));
      if (ch.weekEnergy    != null) updates.push(this._updateCapability('meter_power_week',       ch.weekEnergy));
      if (ch.dayEnergy     != null) updates.push(this._updateCapability('meter_power_day',        ch.dayEnergy));

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
    this.log(`Em01pDevice deleted: ${this.getName()}`);
    this._stopPolling();
    await this._teardownWebhook();
  }

}

module.exports = Em01pDevice;
