'use strict';

const Homey = require('homey');

// Channel sub-devices for EM06P and EM16P.
// Each instance handles one CT transformer identified by integer channelId (1-based).
//
// Data flow:
//   Parent device (em06p/em16p) is the ONLY one that polls the Refoss device.
//   On each poll it calls app.dispatchChannelUpdate(mac, channelId, data).
//   This device receives that dispatch via the registered channel handler.
//
// NOTE: Do NOT add independent polling here — having 6 or 18 channels each
// polling the same Refoss device simultaneously overwhelms it and causes
// connection errors and rapid available/unavailable cycles (flow card storm).

const ENERGY_RESET_EPSILON_KWH = 0.05;

class EmChannelDevice extends Homey.Device {

  async onInit() {
    this.log(`EmChannelDevice initialized: ${this.getName()}`);

    // Immutable identity stored in device data
    this._channelId  = this.getData().channelId;
    this._deviceMac  = this.getData().deviceMac || this.getData().mac;
    this._cumulativeMeters = {};

    // Register with the app so the parent device's poll is routed here by channelId.
    // The parent calls app.dispatchChannelUpdate(mac, channelId, data) after every poll.
    this.homey.app.registerChannelHandler(this._deviceMac, this._channelId, (data) => {
      this._onChannelData(data).catch(err => this.error('Channel data error:', err.message));
    });

    this.log(`EmChannelDevice ch${this._channelId} ready — waiting for parent dispatch`);
  }

  // ---------------------------------------------------------------------------
  // Called by app when parent device dispatches a channel update
  // data = { channelId, power, voltage, current, pf, monthEnergy, ... }
  // ---------------------------------------------------------------------------

  async _onChannelData(data) {
    if (data && data.power === 0) {
      if (data.apparentPower == null) data.apparentPower = 0;
      if (data.current == null) data.current = 0;
      if (data.pf == null) data.pf = 0;
    }

    const updates = [];
    if (data.power          != null) updates.push(this._updateCapability('measure_power',          data.power));
    if (data.voltage        != null) updates.push(this._updateCapability('measure_voltage',        data.voltage));
    if (data.current        != null) updates.push(this._updateCapability('measure_current',        data.current));
    if (data.apparentPower  != null) updates.push(this._updateCapability('measure_apparent_power', data.apparentPower));
    if (data.pf             != null) updates.push(this._updateCapability('measure_power_factor',   data.pf));

    if (data.monthEnergy != null) {
      const cumulative = this._monthlyToCumulative(data.monthEnergy, 'imported', 'meter_power');
      if (cumulative != null) updates.push(this._updateCapability('meter_power', cumulative));
    }
    if (data.monthRetEnergy != null) {
      const cumulative = this._monthlyToCumulative(data.monthRetEnergy, 'exported', 'meter_power.exported');
      if (cumulative != null) updates.push(this._updateCapability('meter_power.exported', cumulative));
    }
    if (data.weekEnergy != null) updates.push(this._updateCapability('meter_power_week', data.weekEnergy));
    if (data.dayEnergy  != null) updates.push(this._updateCapability('meter_power_day',  data.dayEnergy));

    if (data.dayEnergy != null) {
      const price = this.homey.app.getElectricityPrice(this._deviceMac);
      if (price > 0) {
        const symbol = this.homey.app.getCurrencySymbol(this._deviceMac);
        await this.setCapabilityOptions('meter_cost_day', { units: symbol }).catch(() => {});
        updates.push(this._updateCapability('meter_cost_day', data.dayEnergy * price));
      }
    }

    await Promise.all(updates).catch(err => this.error('Capability update error:', err.message));
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async _updateCapability(cap, newValue) {
    if (newValue == null || !this.hasCapability(cap)) return;
    const oldValue = this.getCapabilityValue(cap);
    await this.setCapabilityValue(cap, newValue);

    if (newValue === oldValue) return;

    const app = this.homey.app;
    if (cap === 'measure_power')    app.triggerPowerChanged(this, newValue).catch(() => {});
    if (cap === 'meter_power')      app.triggerMonthEnergy(this, newValue).catch(() => {});
    if (cap === 'meter_power_week') app.triggerWeekEnergy(this, newValue).catch(() => {});
    if (cap === 'meter_power_day')  app.triggerDayEnergy(this, newValue).catch(() => {});
  }

  _monthlyToCumulative(rawMonthlyValue, meterKey, capabilityId) {
    if (rawMonthlyValue == null) return null;
    const monthly = Number(rawMonthlyValue);
    if (!Number.isFinite(monthly) || monthly < 0) return null;

    let state = this._cumulativeMeters[meterKey];
    if (!state) {
      const existing = Number(this.getCapabilityValue(capabilityId));
      const baseline = Number.isFinite(existing) ? Math.max(existing, monthly) : monthly;
      state = { lastMonthly: monthly, cumulative: baseline };
      this._cumulativeMeters[meterKey] = state;
      return baseline;
    }

    let delta = 0;
    if (monthly + ENERGY_RESET_EPSILON_KWH >= state.lastMonthly) {
      delta = Math.max(0, monthly - state.lastMonthly);
    } else {
      delta = monthly; // counter reset (month boundary)
    }
    state.lastMonthly = monthly;
    state.cumulative += delta;
    return Number(state.cumulative.toFixed(6));
  }

  async onSettings({ newSettings }) {
    // No API to reinitialise — channel devices receive all data from parent dispatch.
    // Settings changes (ip_address, poll_interval) are handled on the parent device.
  }

  async onDeleted() {
    this.log(`EmChannelDevice ch${this._channelId} deleted`);
    this.homey.app.unregisterChannelHandler(this._deviceMac, this._channelId);
  }

}

module.exports = EmChannelDevice;
