Refoss Energy Monitor integrates Refoss energy monitoring devices (EM01P, EM06P, EM16P) with Homey Pro over your local network. No cloud account required.


SUPPORTED DEVICES

- EM01P — 1 channel, single CT transformer
- EM06P — 6 channels, three-phase (A1/B1/C1, A2/B2/C2), 120A max per CT
- EM16P — 18 channels, three-phase, 6 channels per phase (A1–A6, B1–B6, C1–C6)


FEATURES

- Each CT transformer channel appears as its own device in Homey
- Live readings: Power (W), Voltage (V), Current (A), Power Factor
- Cumulative energy: today, this week, this month (kWh)
- Cost tracking: set your electricity price and currency per device
- Real-time push updates via webhook — near-instant readings without constant polling
- Fallback polling every 60 seconds as safety net
- Configurable poll interval (5–300 seconds, default 10 s)
- Devices marked unavailable when unreachable; auto-recovers on reconnect
- Full Homey Energy dashboard support
- Dashboard widget: shows all circuits with energy and cost, sortable by consumption or name
- Flow card support: triggers and conditions for power, voltage, current, and energy


SETUP

1. Make sure your Refoss device is on the same local network as your Homey Pro
2. Find the device IP address in your router's DHCP table or the Refoss app
3. In Homey, go to Devices > Add Device > Refoss Energy Monitor
4. Select the device model and enter its IP address
5. For EM06P / EM16P, select which channels to add and optionally rename them

Webhook push registration happens automatically — no manual configuration needed.


REQUIREMENTS

- Homey Pro with firmware 12.3.0 or newer
- Refoss EM01P, EM06P, or EM16P on the same LAN as Homey Pro
- No Refoss cloud account needed


SUPPORT

Please report issues at:
https://github.com/kodalissri/com.refoss.energymonitor/issues
