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
    let deviceInfo = null;
    let customName = null;

    session.setHandler('validate_ip', async (data) => {
      ipAddress = (data.ip_address || '').trim();
      customName = (data.device_name || '').trim() || null;

      if (!ipAddress || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ipAddress)) {
        throw new Error(this.homey.__('pair.error_no_ip'));
      }

      try {
        const api = new RefossApi(ipAddress);
        deviceInfo = await api.getSystemInfo();
        return { success: true, deviceInfo };
      } catch (err) {
        this.error('validate_ip failed:', err.message);
        throw new Error(this.homey.__('pair.error_connect'));
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
            ip_address: ipAddress,
            poll_interval: 10,
          },
        },
      ];
    });
  }

}

module.exports = Em01pDriver;
