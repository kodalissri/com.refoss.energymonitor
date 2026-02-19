# Refoss Energy Monitor — Homey App

Integrates Refoss energy monitoring devices (EM01P, EM06P, EM16P) with Homey Pro over your local network. No cloud required.

## Supported Devices

| Device | Channels | Notes |
|---|---|---|
| EM01P | 1 | Single CT transformer |
| EM06P | 6 | Three-phase, 2× three channels (A1/B1/C1, A2/B2/C2), 120A max |
| EM16P | 18 | Three-phase, 6 channels per phase (A1–A6, B1–B6, C1–C6), 200A on A1/B1 |

## Features

- Each CT transformer channel appears as its own device in Homey with:
  - **Power** (W) — live reading
  - **Energy** (kWh) — cumulative total
  - **Voltage** (V)
  - **Current** (A)
- Aggregate "parent" device shows totals across all channels
- Configurable poll interval (default 10 seconds, min 5 seconds)
- Devices marked unavailable when unreachable; recovers automatically
- Full Homey Energy dashboard support

## Setup

1. Make sure your Refoss device is on the same local network as your Homey Pro
2. Find the device's IP address (check your router's DHCP table or the Refoss app)
3. In Homey, go to **Devices → Add Device → Refoss Energy Monitor**
4. Select the device type and enter the IP address
5. For EM06P/EM16P, select which channels to add and optionally rename them

## Requirements

- Homey Pro (SDK 3, Homey firmware ≥ 12.0.0)
- Refoss device on the same LAN as Homey Pro
- No cloud account needed

## API Notes

All communication uses the Refoss local HTTP API:
- `GET http://<device_ip>/rpc/Em.Status.Get?id=0` — live readings
- `GET http://<device_ip>/rpc/Em.Data.Get?id=0` — cumulative energy
- `GET http://<device_ip>/rpc/Refoss.GetDeviceInfo` — device identity

Units returned by device: power in mW, voltage in mV, current in mA, energy in Wh.
This app converts all values to W, V, A, kWh.

## Development

```bash
npm install -g homey
cd "Refoss Homey App"
homey app run
```

## EM01P Note

The EM01P API is documented as "coming soon" by Refoss. This driver assumes the same
`Em` component API as EM06P/EM16P with a single channel keyed `a`. Update `lib/RefossApi.js`
if the actual API differs.
