# Use react-native-zeroconf for mDNS discovery

MQTT Scout RN discovers MQTT brokers via Bonjour/mDNS. Platform backends:

| Platform | Backend |
|----------|---------|
| **iOS** | `react-native-zeroconf` v0.14.x — Bonjour / NetService |
| **Android** | Local Expo module [`mqtt-zeroconf-nsd`](../../modules/mqtt-zeroconf-nsd/) — `NsdManager` parallel watches. See [0003](./0003-android-nsdmanager-module.md). |

Stock `react-native-zeroconf` NSD was tried and **rejected on Android** for dual-homed S928B — WS/WSS rotation stops browse before hotspot resolve completes ([0005](./0005-revert-stock-react-native-zeroconf.md)).

Discovery requires an Expo dev build (prebuild); it does not run in Expo Go.

## Why react-native-zeroconf (iOS)

1. **TXT records** — `buildConnectUrl` uses `txt.path` (default `/mqtt`).
2. **Bonjour** — platform-native on iOS; `NSBonjourServices` + local network permission.
3. **WS + WSS** — rotate `_mqtt-ws` and `_mqtt-wss` scans on an 8s interval (one browse at a time on iOS).

## Why mqtt-zeroconf-nsd (Android)

1. **Dual-homed** — parallel `_mqtt-ws` + `_mqtt-wss` without rotation stop; hotspot AP brokers resolve on S928B.
2. **No embedded DNSSD** — framework `NsdManager` only.
3. **Capacitor parity** — hard refresh on pull-to-refresh.

## Consequences

- [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts): Android → `mqtt-zeroconf-nsd`; iOS → `react-native-zeroconf`.
- [`react-native.config.js`](../../react-native.config.js): exclude `react-native-zeroconf` on Android.
- Rebuild dev client after native module changes.
