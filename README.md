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

All communication uses the Refoss local HTTP API (no cloud):
- `GET http://<device_ip>/rpc/Refoss.GetDeviceInfo` — device identity and MAC
- `GET http://<device_ip>/rpc/Em.Status.Get?id=65535` — live readings for all channels

Units are returned in SI units (W, V, A, kWh) — no conversion needed.

Webhook push: the device POSTs to `http://<homey_ip>:8741/webhook/<MAC>` on every
value change, giving near-instant updates without constant polling.

## Development

```bash
npm install -g homey
cd com.refoss.monitor
homey app run
```
