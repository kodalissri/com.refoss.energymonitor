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
    let selectedChannels = RefossApi.EM16P_CHANNELS.map(ch => ({ ...ch, name: ch.label }));

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

    session.setHandler('set_selected_channels', async (data) => {
      if (data && Array.isArray(data.channels) && data.channels.length > 0) {
        selectedChannels = data.channels;
      }
      return { success: true };
    });

    // Return ONLY the main device — em_channel devices are created in onAdded()
    session.setHandler('list_devices', async () => {
      if (!ipAddress) throw new Error('IP address not set');

      const macAddress = (deviceInfo && deviceInfo.mac)
        ? deviceInfo.mac.replace(/:/g, '').toUpperCase()
        : ipAddress.replace(/\./g, '');

      const baseName = (deviceInfo && deviceInfo.name)
        ? deviceInfo.name
        : `Refoss EM16P (${ipAddress})`;

      const normChannels = selectedChannels.map((ch) => ({
        id:    ch.channelId != null ? ch.channelId : ch.id,
        label: ch.label,
        name:  ch.name || ch.label,
      }));

      return [
        {
          name: baseName,
          data: {
            id:  `em16p-${macAddress}`,
            mac: macAddress,
          },
          store: {
            ip_address:        ipAddress,
            selected_channels: JSON.stringify(normChannels),
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

module.exports = Em16pDriver;
