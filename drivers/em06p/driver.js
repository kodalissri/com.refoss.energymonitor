'use strict';

const Homey = require('homey');
const RefossApi = require('../../lib/RefossApi');

class Em06pDriver extends Homey.Driver {

  async onInit() {
    this.log('Em06pDriver initialized');
  }

  async onPair(session) {
    let ipAddress = '';
    let username  = null;
    let password  = null;
    let deviceInfo = null;
    let selectedChannels = RefossApi.EM06P_CHANNELS.map(ch => ({ ...ch, name: ch.label }));

    // Step 1: User enters IP (+ optional credentials), we validate by hitting the device
    session.setHandler('validate_ip', async (data) => {
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

    // Step 2: User picks which channels (and names) to add
    session.setHandler('set_selected_channels', async (data) => {
      if (data && Array.isArray(data.channels) && data.channels.length > 0) {
        selectedChannels = data.channels;
      }
      return { success: true };
    });

    // Step 3: Homey asks for the list of devices to add
    session.setHandler('list_devices', async () => {
      if (!ipAddress) throw new Error('IP address not set');

      const macAddress = (deviceInfo && deviceInfo.mac)
        ? deviceInfo.mac.replace(/:/g, '').toUpperCase()
        : ipAddress.replace(/\./g, '');

      const baseName = (deviceInfo && deviceInfo.name)
        ? deviceInfo.name
        : `Refoss EM06P (${ipAddress})`;

      // Main aggregate device
      const mainDevice = {
        name: baseName,
        data: {
          id: `em06p-${macAddress}`,
          mac: macAddress,
        },
        store: { ip_address: ipAddress },
        settings: {
          ip_address:    ipAddress,
          poll_interval: 10,
          username:      username || '',
          password:      password || '',
        },
      };

      // Channel sub-devices — channelId is the integer from RefossApi.EM06P_CHANNELS
      const channelDriver = this.homey.drivers.getDriver('em_channel');
      // ch.id comes from RefossApi.EM06P_CHANNELS default; ch.channelId comes
      // from list_channels.html emit. Support both so either source works.
      const channelDevices = selectedChannels.map((ch) => {
        const chId = ch.channelId != null ? ch.channelId : ch.id;
        return {
          name: ch.name || ch.label,
          driver: channelDriver,
          data: {
            id:          `em06p-${macAddress}-ch${chId}`,
            channelId:   chId,          // integer 1-based, used for webhook routing
            deviceMac:   macAddress,    // parent MAC for webhook routing
            deviceModel: 'em06p',
          },
          store: { ip_address: ipAddress },
          settings: {
            ip_address:    ipAddress,
            poll_interval: 10,
            channel_label: ch.label,
            username:      username || '',
            password:      password || '',
          },
        };
      });

      return [mainDevice, ...channelDevices];
    });
  }

}

module.exports = Em06pDriver;
