# Changelog

## 1.0.0 (2026-02-24)

### Initial release

- Support for Refoss EM01P (1-channel), EM06P (6-channel) and EM16P (18-channel) energy monitors
- Local network integration — no cloud account required
- Each CT transformer channel appears as its own Homey device
- Live readings: Power (W), Voltage (V), Current (A), Power Factor
- Cumulative energy: today, this week, this month (kWh)
- Configurable electricity price and currency per device for cost tracking
- Real-time push updates via webhook (device POSTs on every change)
- Automatic webhook registration — zero manual setup
- Fallback polling every 60 seconds as safety net
- Configurable poll interval (5–300 seconds, default 10 s)
- Devices marked unavailable when unreachable; auto-recovers on reconnect
- Full Homey Energy dashboard support (cumulative meter)
- Dashboard widget: Circuit Energy Summary
  - Shows all circuits with energy and cost for Today / This Week / This Month
  - Sortable by highest, lowest or alphabetical order
  - Per-device toggle to include/exclude from widget
- Flow card support: triggers, conditions for power, voltage, current, energy
