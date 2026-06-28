# Phase 3 — Device matrix (S928B, 2026-06-28)

Device: Samsung SM-S928B (`R3CX90A30EW`), patched `react-native-zeroconf` dual DNSSD.

## Matrix

| # | Scenario | Setup | Expected | Result | Notes |
|---|----------|-------|----------|--------|-------|
| 1 | **Upstream WiFi only** | Hotspot off, WiFi on `kehrer` | `mode=none`, single upstream browse (`ALL_INTERFACES` or wlan0) | **Not run** | Hotspot was active (`swlan0` up) entire session; disable tethering to re-test |
| 2 | **Hotspot only** | Hotspot on, WiFi STA off | `mode=hotspotOnly`, browse on `swlan0` only | **Not run** | Needs WiFi disconnect + hotspot on |
| 3 | **Dual-homed** | WiFi + hotspot (`wlan0` + `swlan0`) | `mode=dualHomed`, two browses, no crash | **PASS** | `upstreamIf=45` (wlan0), `hotspotIf=52` (swlan0) |
| 4 | **Startup stability** | Cold start in dual-homed | No SIGABRT / JNI error | **PASS** | Single `DNSSDEmbedded` init after synchronized `init()` fix |
| 5 | **Discovery resolves** | Brokers on LAN | `RNZeroconfResolved` with `browseKey` | **PASS** | Upstream brokers resolved; `browseKey` present in native logs |
| 6 | **Hotspot ESP** | ESP on `10.24.204.211` pingable | Broker in Hotspot section | **Pending** | ESP reachable via ping; no `10.24.204.x` mDNS resolve in 20s capture — verify ESP advertises `_mqtt-ws._tcp` on AP |
| 7 | **Refresh** | Tap Refresh in dual-homed | Rescan both legs, no error | **PASS** (after fix) | Pre-fix: `ConcurrentModificationException` in `stopAllBrowses`; fixed with `new ArrayList<>(keySet())` |
| 8 | **Hotspot off purge** | Turn tethering off while app open | Hotspot section clears | **Not run** | Requires manual tethering toggle |

## Log evidence (scenario 3)

```
NetworkDiscovery: mode=dualHomed upstreamIf=45 hotspotIf=52
DnssdImpl: Starting browse key=upstream ifIndex=45 type=_mqtt-ws._tcp
DnssdImpl: Starting browse key=hotspot ifIndex=52 type=_mqtt-ws._tcp
DNSSDEmbedded: init
DNSSDEmbedded: start
DNSSDEmbedded: already started
DnssdImpl: {..."browseKey":"upstream","addresses":["10.100.100.178"],..."MacOS Mosquitto MQTT-WS"...}
DnssdImpl: {..."browseKey":"hotspot","addresses":["10.100.100.178"],..."MacOS Mosquitto MQTT-WS"...}
```

## Known issues

1. **Cross-leg leakage:** Interface-bound hotspot browse still resolves some upstream-subnet (`10.100.100.x`) brokers with `browseKey=hotspot`. Segmentation is by browse leg, not IP subnet. May duplicate entries in UI when dual-homed. Consider subnet filter on hotspot leg if needed.

2. **Refresh CME:** Fixed in patch — `stopAllBrowses()` must copy key set before iteration.

## Manual steps to finish matrix

1. **Upstream only:** Settings → turn off Mobile hotspot → relaunch app → expect `mode=none`.
2. **Hotspot only:** Disconnect WiFi → hotspot on → ESP connected → expect `mode=hotspotOnly`, ESP under Hotspot.
3. **Purge:** From dual-homed, turn hotspot off → expect `RNZeroconfHotspotPurged` / empty Hotspot section.

## Gate

Dual DNSSD replaces JmDNS when scenarios 1–3 and 7–8 pass on device. Scenarios 3–5 and 7 pass; 1, 2, 6, 8 need manual network toggles.
