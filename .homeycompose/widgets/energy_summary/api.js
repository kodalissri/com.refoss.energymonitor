'use strict';

module.exports = {

  async getEnergy({ homey, query }) {
    const deviceId = (query && query.deviceId) || null;
    const period = String((query && query.period) || 'day').toLowerCase();

    const matches = (d) => {
      if (!deviceId) return false;
      try {
        if (typeof d.getId === 'function' && String(d.getId()) === String(deviceId)) return true;
      } catch (_) {}
      try {
        const data = d.getData && d.getData();
        if (data && String(data.id) === String(deviceId)) return true;
      } catch (_) {}
      try {
        if (String(d.id) === String(deviceId)) return true;
      } catch (_) {}
      return false;
    };

    let selectedDevice = null;
    if (deviceId) {
      for (const driverId of ['em16p', 'em06p', 'em01p', 'em_channel']) {
        try {
          const driver = homey.drivers.getDriver(driverId);
          for (const d of driver.getDevices()) {
            if (matches(d)) {
              selectedDevice = d;
              break;
            }
          }
          if (selectedDevice) break;
        } catch (_) {}
      }
    }

    let selectedMac = null;
    try {
      const data = selectedDevice && selectedDevice.getData && selectedDevice.getData();
      selectedMac = data ? (data.mac || data.deviceMac || null) : null;
    } catch (_) {}

    const periodCapability = period === 'week'
      ? 'meter_power_week'
      : (period === 'month' ? 'meter_power' : 'meter_power_day');
    const includeInWidget = (d) => {
      try {
        return d.getSetting('include_in_widget') !== false;
      } catch (_) {
        return true;
      }
    };

    const channels = [];
    let currencySymbol = 'EUR';
    let symbolSet = false;

    for (const driverId of ['em16p', 'em06p', 'em_channel', 'em01p']) {
      try {
        const driver = homey.drivers.getDriver(driverId);
        for (const d of driver.getDevices()) {
          if (!includeInWidget(d)) continue;
          const data = d.getData && d.getData();
          if (!data) continue;
          const isEm01 = driverId === 'em01p';
          if (!isEm01 && !data.channelId) continue;

          const dMac = data.mac || data.deviceMac || null;
          if (selectedMac && String(dMac).toUpperCase() !== String(selectedMac).toUpperCase()) continue;

          const raw = d.getCapabilityValue(periodCapability);
          const energy = (raw != null && Number.isFinite(Number(raw))) ? Number(raw) : null;

          let price = 0;
          try {
            if (dMac) price = homey.app.getElectricityPrice(dMac);
          } catch (_) {}

          if (!symbolSet && dMac) {
            try {
              currencySymbol = homey.app.getCurrencySymbol(dMac);
              symbolSet = true;
            } catch (_) {}
          }

          channels.push({
            id: String(data.id || (d.getId && d.getId()) || ''),
            name: d.getName(),
            channelId: isEm01 ? 1 : Number(data.channelId),
            energy,
            cost: (price > 0 && energy != null) ? energy * price : null,
          });
        }
      } catch (_) {}
    }

    channels.sort((a, b) => {
      if (Number.isFinite(a.channelId) && Number.isFinite(b.channelId)) return a.channelId - b.channelId;
      return a.name.localeCompare(b.name);
    });

    return {
      name: 'Energy Summary',
      period,
      periodLabel: period === 'week' ? 'This Week' : (period === 'month' ? 'This Month' : 'Today'),
      currencySymbol,
      channels,
    };
  },

};
