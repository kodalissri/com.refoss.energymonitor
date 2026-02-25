'use strict';

const Homey = require('homey');
const RefossApi = require('../../lib/RefossApi');

// EM01P is a single-channel energy monitor (API docs marked "coming soon").
// It follows the same Em component API as EM06P/EM16P with a single 'a' channel.

class Em01pDriver extends Homey.Driver {

  async onInit() {
    this.log('Em01pDriver initialized');
  }

  async onPair(session) {
    let ipAddress = '';
    let username   = null;
    let password   = null;
    let deviceInfo = null;
    let customName = null;

    session.setHandler('pair_log', async (payload) => {
      const msg = payload && payload.message ? payload.message : String(payload || '');
      this.log(`[PairUI] ${msg}`);
      return true;
    });

    session.setHandler('validate_ip', async (data) => {
      ipAddress  = (data.ip_address || '').trim();
      customName = (data.device_name || '').trim() || null;
      username   = (data.username || '').trim() || null;
      password   = data.password || null;

      if (!ipAddress || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ipAddress)) {
        throw new Error(this.homey.__('pair.error_no_ip'));
      }

      try {
        const api = new RefossApi(ipAddress, username, password);
        deviceInfo = await api.getSystemInfo();
        return { success: true, deviceInfo };
      } catch (err) {
        this.error('validate_ip failed:', err.message);
        throw new Error(err.message || this.homey.__('pair.error_connect'));
      }
    });

    session.setHandler('list_devices', async () => {
      if (!ipAddress) throw new Error('IP address not set');

      const macAddress = (deviceInfo && deviceInfo.mac)
        ? deviceInfo.mac.replace(/:/g, '').toUpperCase()
        : ipAddress.replace(/\./g, '');

      const deviceName = customName
        || (deviceInfo && deviceInfo.name)
        || `Refoss EM01P (${ipAddress})`;

      const existingMain = this.getDevices().find((device) => {
        const existingMac = String((device.getData && device.getData().mac) || '').toUpperCase();
        return existingMac && existingMac === macAddress;
      });
      if (existingMain) {
        throw new Error('This Refoss EM01P is already added in Homey.');
      }

      return [
        {
          name: deviceName,
          data: {
            id: `em01p-${macAddress}`,
            mac: macAddress,
          },
          store: {
            ip_address: ipAddress,
          },
          settings: {
            ip_address:    ipAddress,
            poll_interval: 10,
            username:      username || '',
            password:      password || '',
          },
        },
      ];
    });
  }

}

module.exports = Em01pDriver;
