'use strict';

const Homey = require('homey');

// This driver is used for individual channel sub-devices of EM06P and EM16P.
// Channel devices are added programmatically during pairing of the parent device,
// not through this driver's own pairing flow.

class EmChannelDriver extends Homey.Driver {

  async onInit() {
    this.log('EmChannelDriver initialized');
  }

  // Called only if a user somehow tries to pair this driver directly.
  // In normal operation channels are created by the parent driver's pairing session.
  async onPairListDevices() {
    return [];
  }

}

module.exports = EmChannelDriver;
