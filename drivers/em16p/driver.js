'use strict';

const Homey = require('homey');
const RefossApi = require('../../lib/RefossApi');

class Em16pDriver extends Homey.Driver {

  async onInit() {
    this.log('Em16pDriver initialized');
  }

  async onPair(session) {
    let ipAddress = '';
    let username  = null;
    let password  = null;
    let deviceInfo = null;

    session.setHandler('validate_ip', async (data) => {
      this.log('Pair validate_ip called');
      ipAddress = (data.ip_address || '').trim();
      username  = (data.username || '').trim() || null;
      password  = data.password || null;

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
      this.log('Pair list_devices called');
      if (!ipAddress) throw new Error('IP address not set');

      const macAddress = (deviceInfo && deviceInfo.mac)
        ? deviceInfo.mac.replace(/:/g, '').toUpperCase()
        : ipAddress.replace(/\./g, '');

      const baseName = (deviceInfo && deviceInfo.name)
        ? deviceInfo.name
        : `Refoss EM16P (${ipAddress})`;

      const existingMain = this.getDevices().find((device) => {
        const existingMac = String((device.getData && device.getData().mac) || '').toUpperCase();
        return existingMac && existingMac === macAddress;
      });
      if (existingMain) {
        throw new Error('This Refoss EM16P is already added in Homey.');
      }

      const devices = [
        {
          name: baseName,
          data: {
            id:  `em16p-${macAddress}`,
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

      for (const ch of RefossApi.EM16P_CHANNELS) {
        devices.push({
          name: ch.label,
          driverId: 'em_channel',
          driver_id: 'em_channel',
          driverUri: 'homey:app:com.refoss.energymonitor',
          data: {
            id: `em16p-${macAddress}-ch${ch.id}`,
            channelId: ch.id,
            deviceMac: macAddress,
            deviceModel: 'em16p',
            mac: macAddress,
          },
          store: {
            ip_address: ipAddress,
          },
          settings: {
            ip_address: ipAddress,
            poll_interval: 10,
            channel_label: ch.label,
            username: username || '',
            password: password || '',
          },
        });
      }

      this.log(`Pair list_devices count: ${devices.length}`);
      return devices;
    });
  }

}

module.exports = Em16pDriver;
