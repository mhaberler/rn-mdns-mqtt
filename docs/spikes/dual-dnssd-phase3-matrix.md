# Phase 3 — Device matrix (S928B)

Device: Samsung SM-S928B (`R3CX90A30EW`), patched `react-native-zeroconf` dual DNSSD.

Last updated: 2026-06-28 (post-watchdog commit `99fc7de`).

## Matrix

| # | Scenario | Setup | Expected | Result | Notes |
|---|----------|-------|----------|--------|-------|
| 1 | **Upstream WiFi only** | Hotspot off, WiFi on `kehrer` | `mode=none`, single upstream browse | **Not run** | Hotspot stayed active during automated sessions |
| 2 | **Hotspot only** | Hotspot on, WiFi STA off | `mode=hotspotOnly`, browse on `swlan0` only | **Not run** | Needs WiFi disconnect + hotspot on |
| 3 | **Dual-homed** | WiFi + hotspot (`wlan0` + `swlan0`) | `mode=dualHomed`, two browses, no crash | **PASS** | `upstreamIf=45`, `hotspotIf=52`/`53` |
| 4 | **Startup stability** | Cold start in dual-homed | No SIGABRT / JNI error | **PASS** | Single `DNSSDEmbedded` init after synchronized `init()` |
| 5 | **Discovery resolves** | Brokers on LAN | `RNZeroconfResolved` with `browseKey` | **PASS** | Upstream + hotspot legs; subnet filter active |
| 6 | **Hotspot ESP** | ESP @ `10.24.204.211` on AP | Broker in Hotspot section | **PASS** (intermittent) | Resolves with `browseKey=hotspot`; watchdog recovers deaf browse ~20s |
| 7 | **Refresh** | Tap Refresh in dual-homed | Rescan both legs, no error | **PASS** | `stopAllBrowses()` CME fixed |
| 8 | **Hotspot off purge** | Turn tethering off while app open | Hotspot section clears | **Not run** | Requires manual tethering toggle |

## Log evidence (dual-homed + ESP)

```
NetworkDiscovery: mode=dualHomed upstreamIf=45 hotspotIf=53
DnssdImpl: Starting browse key=upstream ifIndex=45 type=_mqtt-ws._tcp
DnssdImpl: Starting browse key=hotspot ifIndex=53 type=_mqtt-ws._tcp
DnssdImpl: Skipping key=hotspot name=fpc ipv4=[10.100.100.147] not in hotspotCidr=10.24.204.154/24
DnssdImpl: {"browseKey":"hotspot","addresses":["10.24.204.211"],..."Sensorpod MQTT broker - WS at esp32-4483D8"...}
DnssdImpl: Hotspot watchdog stale: resolveAge=22415ms — forcing re-browse
DnssdImpl: {"browseKey":"hotspot","addresses":["10.24.204.211"],...}  # re-found after force
```

## Resolved issues

1. **Cross-leg leakage** — Subnet filter on hotspot/upstream legs drops wrong-CIDR resolves.
2. **Refresh CME** — `stopAllBrowses()` iterates `new ArrayList<>(keySet())`.
3. **Probe loop** — Forced re-browse only on initial 800ms probe, not every refresh.
4. **Deaf hotspot browse** — 15s watchdog poll; force re-browse when stale 20s.

## Gate

Dual DNSSD **accepted** for upstream + dual-homed on S928B. Scenarios 1, 2, 8 still need manual network toggles before store submit. Hotspot ESP intermittent on Samsung AP — document ~20s worst case in review notes.

## Manual steps to finish matrix

1. **Upstream only:** Turn off Mobile hotspot → relaunch → expect `mode=none`.
2. **Hotspot only:** Disconnect WiFi → hotspot on → ESP connected → expect `mode=hotspotOnly`.
3. **Purge:** From dual-homed, turn hotspot off → expect `RNZeroconfHotspotPurged` / empty Hotspot section.
