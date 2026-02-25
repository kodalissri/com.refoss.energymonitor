'use strict';

const Homey = require('homey');
const RefossApi = require('../../lib/RefossApi');

// Fallback poll interval when webhook is active (safety net for missed pushes).
// 60s keeps values fresh. Channel devices never poll — only the parent does.
const FALLBACK_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_POLL_INTERVAL_S   = 10;
const MIN_POLL_INTERVAL_S       = 5;
const POLL_RETRY_DELAY_MS       = 500;
const POLL_MAX_CONSEC_FAILS     = 3;
const POLL_JITTER_RATIO         = 0.10;

class Em06pDevice extends Homey.Device {

  async onInit() {
    this.log(`Em06pDevice initialized: ${this.getName()}`);

    this._mac             = this.getData().mac;
    this._channelId       = this.getData().channelId || null;
    this._isChannelDevice = this._channelId != null;
    this._ipAddress       = this.getStoreValue('ip_address') || this.getSetting('ip_address');
    this._username        = this.getSetting('username') || null;
    this._password        = this.getSetting('password') || null;
    this._pollInterval    = Math.max(MIN_POLL_INTERVAL_S, this.getSetting('poll_interval') || DEFAULT_POLL_INTERVAL_S) * 1000;
    this._api             = new RefossApi(this._ipAddress, this._username, this._password);
    this._webhookId       = null;
    this._webhookActive   = false;
    this._consecutivePollFailures = 0;
    this._loggedFirstMainPoll = false;
    this._loggedFirstChannelUpdate = false;

    if (this._isChannelDevice) {
      if (this.hasCapability('measure_temperature')) {
        await this.removeCapability('measure_temperature').catch(() => {});
      }
      const channelCapsToEnsure = [
        'meter_power',
        'meter_power.exported',
        'meter_power_week',
        'meter_power_day',
        'meter_cost_day',
      ];
      for (const cap of channelCapsToEnsure) {
        if (!this.hasCapability(cap)) {
          await this.addCapability(cap).catch(() => {});
        }
      }
      // Channel devices never poll independently — all data comes from the parent
      // device's poll (dispatched via dispatchChannelUpdate) or from webhook pushes
      // (dispatched via registerChannelHandler). Independent channel polls cause a
      // connection storm: 6 simultaneous HTTP requests overwhelm the device.
      this.homey.app.registerChannelHandler(this._mac, this._channelId, (data) => {
        this._onWebhookData(data).catch(err => this.error('Webhook channel handler error:', err.message));
      });
      return;
    }

    await this._pollDevice().catch(err => this.error('Initial poll failed:', err.message));
    await this._setupWebhook();
  }

  async _setupWebhook() {
    this._stopPolling();
    let emEvent = null;
    let webhookUrl = null;
    try {
      emEvent    = await this._resolveEmEvent();
      webhookUrl = await this.homey.app.getWebhookUrl(this._mac);

      this.homey.app.registerWebhookHandler(this._mac, (data) => {
        this._onWebhookData(data).catch(err => this.error('Webhook handler error:', err.message));
      });

      const regResult = await this._api.registerHomeyWebhook(webhookUrl, emEvent, {
        channelIds: RefossApi.EM06P_CHANNELS.map(ch => ch.id),
      });
      this._webhookId     = (regResult && regResult.id !== undefined) ? regResult.id : regResult;
      this._webhookActive = true;
      this.log(`Webhook registered (id=${this._webhookId}) for ${this.getName()}`);
      if (regResult && regResult.perChannel) {
        this.log(`Webhook per-channel summary: ${JSON.stringify(regResult.perChannel)}`);
      }
      try {
        const diag = await this._api.getWebhookDiagnostics();
        const list = (diag && diag.list && diag.list.hooks) ? diag.list.hooks : [];
        const mine = list.find(h => h.id === this._webhookId) || null;
        const homeyHooks = list
          .filter(h => typeof h.name === 'string' && h.name.startsWith('homeyrefoss'))
          .map(h => ({ id: h.id, name: h.name, event: h.event, cid: h.cid, enable: h.enable }));
        this.log(`Webhook create verification: ${JSON.stringify({ id: this._webhookId, event: emEvent, url: webhookUrl, hook: mine, homeyHooks }).slice(0, 1400)}`);
      } catch (diagErr) {
        this.error(`Webhook verification failed: ${diagErr.message}`);
      }
      this._startPolling(FALLBACK_POLL_INTERVAL_MS);
    } catch (err) {
      let diagText = '';
      try {
        const diag = await this._api.getWebhookDiagnostics();
        diagText = JSON.stringify(diag).slice(0, 1200);
      } catch (diagErr) {
        diagText = `diagnostics_error=${diagErr.message}`;
      }
      this.error(`Webhook setup failed, falling back to polling: ${err.message}; event=${emEvent}; url=${webhookUrl}; diag=${diagText}`);
      this._webhookActive = false;
      this._startPolling(this._pollInterval);
    }
  }

  async _resolveEmEvent() {
    try {
      const resp = await this._api.getSupportedWebhookEvents();
      const types = (resp && resp.result && resp.result.types)
        || (resp && resp.types)
        || resp
        || {};
      const keys = Object.keys(types || {});
      // Prefer emmerge.* events — they fire for ALL channels without needing cid.
      const preferred = [
        'emmerge.power_change',
        'emmerge.current_change',
        'emmerge.voltage_change',
        'em.power_change',
        'em.current_change',
        'em.voltage_change',
      ];
      const preferredKey = preferred.find(k => keys.includes(k));
      if (preferredKey) return preferredKey;
      const emKey = keys.find(k => k.startsWith('emmerge.') || k.startsWith('em.'));
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
    if (data && data.power === 0) {
      // Some webhook payloads report power=0 but omit apparent/current/pf.
      if (data.apparentPower == null) data.apparentPower = 0;
      if (data.current == null) data.current = 0;
      if (data.pf == null) data.pf = 0;
    }

    if (!this._isChannelDevice) {
      this.log(`Webhook trigger received (method=${data && data.method ? data.method : 'unknown'}, ch=${data && data.channelId != null ? data.channelId : 'n/a'})`);
      await this._pollDevice().catch(err => this.error('Post-webhook poll failed:', err.message));
      return;
    }

    const updates = [];
    if (data.power           != null) updates.push(this._updateCapability('measure_power',          data.power));
    if (data.voltage         != null) updates.push(this._updateCapability('measure_voltage',        data.voltage));
    if (data.current         != null) updates.push(this._updateCapability('measure_current',        data.current));
    if (data.monthEnergy     != null) updates.push(this._updateCapability('meter_power',            data.monthEnergy));
    if (data.apparentPower   != null) updates.push(this._updateCapability('measure_apparent_power', data.apparentPower));
    if (data.pf              != null) updates.push(this._updateCapability('measure_power_factor',   data.pf));
    if (data.weekEnergy      != null) updates.push(this._updateCapability('meter_power_week',       data.weekEnergy));
    if (data.dayEnergy       != null) updates.push(this._updateCapability('meter_power_day',        data.dayEnergy));
    if (data.monthRetEnergy  != null) updates.push(this._updateCapability('meter_power.exported',   data.monthRetEnergy));

    if (data.dayEnergy != null) {
      const price = this.homey.app.getElectricityPrice(this._mac);
      if (price > 0) {
        const symbol = this.homey.app.getCurrencySymbol(this._mac);
        await this.setCapabilityOptions('meter_cost_day', { units: symbol }).catch(() => {});
        updates.push(this._updateCapability('meter_cost_day', data.dayEnergy * price));
      }
    }

    await Promise.all(updates).catch(err => this.error('Channel capability update error:', err.message));
    if (!this._loggedFirstChannelUpdate) {
      this._loggedFirstChannelUpdate = true;
      this.log(`First channel update received for ch${this._channelId} (power=${data.power}, month=${data.monthEnergy}, week=${data.weekEnergy}, day=${data.dayEnergy}, voltage=${data.voltage}, current=${data.current})`);
    }
    if (!this.getAvailable()) await this.setAvailable().catch(() => {});
  }

  _startPolling(intervalMs) {
    this._stopPolling();
    const jitter = Math.round(intervalMs * POLL_JITTER_RATIO * ((Math.random() * 2) - 1));
    const effectiveIntervalMs = Math.max(2000, intervalMs + jitter);
    this._pollTimer = this.homey.setInterval(
      () => this._pollDevice().catch(err => this.error('Poll error:', err.message)),
      effectiveIntervalMs
    );
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _getStatusWithRetry() {
    try {
      return await this._api.getEmStatus();
    } catch (err) {
      const msg = String((err && err.message) || '');
      if (!msg.includes('Timeout calling /rpc/Refoss.Status.Get')) throw err;

      await new Promise(resolve => setTimeout(resolve, POLL_RETRY_DELAY_MS));
      return this._api.getEmStatus();
    }
  }

  async _pollDevice() {
    try {
      const raw       = await this._getStatusWithRetry();
      const statusMap = RefossApi.parseEmStatus(raw);
      const numericChannelKeys = Object.keys(statusMap).filter(k => /^\d+$/.test(k));
      if (numericChannelKeys.length === 0) {
        const topKeys = Object.keys(raw || {}).join(',');
        const resultKeys = Object.keys((raw && raw.result) || {}).join(',');
        const snippet = JSON.stringify(raw || {}).slice(0, 280);
        this.error(`No channel entries in status payload. top keys: ${topKeys} result keys: ${resultKeys} raw: ${snippet}`);
      }

      if (this._isChannelDevice) {
        const ch = statusMap[this._channelId];
        if (!ch) throw new Error(`Channel ${this._channelId} not found in response`);

        const updates = [];
        if (ch.power          != null) updates.push(this._updateCapability('measure_power',          ch.power));
        if (ch.voltage        != null) updates.push(this._updateCapability('measure_voltage',        ch.voltage));
        if (ch.current        != null) updates.push(this._updateCapability('measure_current',        ch.current));
        if (ch.monthEnergy    != null) updates.push(this._updateCapability('meter_power',            ch.monthEnergy));
        if (ch.apparentPower  != null) updates.push(this._updateCapability('measure_apparent_power', ch.apparentPower));
        if (ch.pf             != null) updates.push(this._updateCapability('measure_power_factor',   ch.pf));
        if (ch.weekEnergy     != null) updates.push(this._updateCapability('meter_power_week',       ch.weekEnergy));
        if (ch.dayEnergy      != null) updates.push(this._updateCapability('meter_power_day',        ch.dayEnergy));
        if (ch.monthRetEnergy != null) updates.push(this._updateCapability('meter_power.exported',   ch.monthRetEnergy));

        if (ch.dayEnergy != null) {
          const price = this.homey.app.getElectricityPrice(this._mac);
          if (price > 0) {
            const symbol = this.homey.app.getCurrencySymbol(this._mac);
            await this.setCapabilityOptions('meter_cost_day', { units: symbol }).catch(() => {});
            updates.push(this._updateCapability('meter_cost_day', ch.dayEnergy * price));
          }
        }

        await Promise.all(updates);
        if (!this.getAvailable()) await this.setAvailable();
        return;
      }

      const updates = [];
      let totalPower = 0, hasPower = false;
      let totalCurrent = 0, hasCurrent = false;
      let totalKwh  = 0, hasEnergy  = false;
      let totalWkh  = 0, hasWeek    = false;
      let totalDkh  = 0, hasDay     = false;
      let totalVA   = 0, hasVA      = false;
      let totalRKwh = 0, hasREnergy = false;
      let voltageSum = 0, voltageCount = 0;

      for (const ch of RefossApi.EM06P_CHANNELS) {
        const entry = statusMap[ch.id];
        if (entry) {
          if (entry.power          != null) { totalPower   += entry.power;          hasPower   = true; }
          if (entry.current        != null) { totalCurrent += entry.current;        hasCurrent = true; }
          if (entry.monthEnergy    != null) { totalKwh     += entry.monthEnergy;    hasEnergy  = true; }
          if (entry.weekEnergy     != null) { totalWkh     += entry.weekEnergy;     hasWeek    = true; }
          if (entry.dayEnergy      != null) { totalDkh     += entry.dayEnergy;      hasDay     = true; }
          if (entry.apparentPower  != null) { totalVA      += entry.apparentPower;  hasVA      = true; }
          if (entry.monthRetEnergy != null) { totalRKwh    += entry.monthRetEnergy; hasREnergy = true; }
          if (entry.voltage        != null) { voltageSum   += entry.voltage;        voltageCount++; }

          this.homey.app.dispatchChannelUpdate(this._mac, ch.id, {
            channelId: ch.id,
            ...entry,
          });
        }
      }

      if (hasPower)   updates.push(this._updateCapability('measure_power',          totalPower));
      if (hasCurrent) updates.push(this._updateCapability('measure_current',        totalCurrent));
      if (voltageCount > 0) updates.push(this._updateCapability('measure_voltage',  voltageSum / voltageCount));
      if (hasEnergy)  updates.push(this._updateCapability('meter_power',           totalKwh));
      if (hasWeek)    updates.push(this._updateCapability('meter_power_week',       totalWkh));
      if (hasDay)     updates.push(this._updateCapability('meter_power_day',        totalDkh));
      if (hasVA)      updates.push(this._updateCapability('measure_apparent_power', totalVA));
      if (hasREnergy) updates.push(this._updateCapability('meter_power.exported',   totalRKwh));
      if (statusMap.temperature != null) updates.push(this._updateCapability('measure_temperature', statusMap.temperature));

      if (hasPower && hasVA && totalVA > 0) {
        const totalPf = Math.max(-1, Math.min(1, totalPower / totalVA));
        updates.push(this._updateCapability('measure_power_factor', totalPf));
      }

      await Promise.all(updates);
      if (this._consecutivePollFailures > 0) {
        this.log(`Poll recovered after ${this._consecutivePollFailures} consecutive failure(s)`);
      }
      this._consecutivePollFailures = 0;
      if (!this._loggedFirstMainPoll) {
        this._loggedFirstMainPoll = true;
        const rawSys = ((raw && raw.result && raw.result.sys) || (raw && raw.sys) || {});
        const sysSnippet = JSON.stringify(rawSys).slice(0, 220);
        this.log(`First main poll applied (sum_power=${totalPower}, sum_current=${totalCurrent}, temp=${statusMap.temperature}, sys=${sysSnippet})`);
      }
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err) {
      this.error('Poll failed:', err.message);
      this._consecutivePollFailures += 1;
      if (this._consecutivePollFailures < POLL_MAX_CONSEC_FAILS) {
        this.log(`Poll transient failure ${this._consecutivePollFailures}/${POLL_MAX_CONSEC_FAILS}; keeping device available`);
        return;
      }
      if (this.getAvailable())
        await this.setUnavailable(this.homey.__('device.unreachable')).catch(() => {});
    }
  }

  async onAdded() {
    this.log(`Em06pDevice added: ${this.getName()}`);
  }

  async onSettings({ newSettings }) {
    let ipChanged = false;
    let authChanged = false;
    let pollChanged = false;

    if (newSettings.ip_address !== undefined && newSettings.ip_address !== this._ipAddress) {
      this._ipAddress = newSettings.ip_address;
      await this.setStoreValue('ip_address', this._ipAddress);
      ipChanged = true;
    }
    if (newSettings.username !== undefined) {
      const nextUsername = newSettings.username || null;
      if (nextUsername !== this._username) {
        this._username = nextUsername;
        authChanged = true;
      }
    }
    if (newSettings.password !== undefined) {
      const nextPassword = newSettings.password || null;
      if (nextPassword !== this._password) {
        this._password = nextPassword;
        authChanged = true;
      }
    }
    if (newSettings.poll_interval !== undefined) {
      const nextPollInterval = Math.max(MIN_POLL_INTERVAL_S, newSettings.poll_interval) * 1000;
      if (nextPollInterval !== this._pollInterval) {
        this._pollInterval = nextPollInterval;
        pollChanged = true;
      }
    }
    if (ipChanged || authChanged) {
      this._api = new RefossApi(this._ipAddress, this._username, this._password);
    }

    if (this._isChannelDevice) {
      return;
    }

    if (!ipChanged && !authChanged && !pollChanged) {
      return;
    }

    if (!ipChanged && !authChanged && pollChanged) {
      if (!this._webhookActive) this._startPolling(this._pollInterval);
      return;
    }

    await this._teardownWebhook();
    await this._setupWebhook();
  }

  async onDeleted() {
    this.log(`Em06pDevice deleted: ${this.getName()}`);
    this._stopPolling();

    if (this._isChannelDevice) {
      this.homey.app.unregisterChannelHandler(this._mac, this._channelId);
      return;
    }

    await this._teardownWebhook();
  }

}

module.exports = Em06pDevice;
