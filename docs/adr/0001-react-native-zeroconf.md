# Use react-native-zeroconf for mDNS discovery

MQTT Scout RN discovers MQTT brokers via Bonjour/mDNS. Platform backends:

| Platform | Backend |
|----------|---------|
| **iOS** | `react-native-zeroconf` v0.14.x — Bonjour / NetService |
| **Android** | Local Expo module [`zeroconf-nsd`](../../modules/zeroconf-nsd/) — `NsdManager` parallel `watchAll`. See [0003](./0003-android-nsdmanager-module.md), [0007](./0007-four-broker-types-zeroconf-nsd.md). |

Stock `react-native-zeroconf` NSD was tried and **rejected on Android** for dual-homed S928B — WS/WSS rotation stops browse before hotspot resolve completes ([0005](./0005-revert-stock-react-native-zeroconf.md)).

Discovery requires an Expo dev build (prebuild); it does not run in Expo Go.

## Why react-native-zeroconf (iOS)

1. **TXT records** — `buildConnectUrl` uses `txt.path` (default `/mqtt`).
2. **Bonjour** — platform-native on iOS; `NSBonjourServices` + local network permission.
3. **WS + WSS + MQTT + MQTTS** — rotate all four Bonjour types on an 8s interval (one browse at a time on iOS). See [0007](./0007-four-broker-types-zeroconf-nsd.md).

## Why zeroconf-nsd (Android)

1. **Dual-homed** — parallel `_mqtt-ws` + `_mqtt-wss` without rotation stop; hotspot AP brokers resolve on S928B.
2. **No embedded DNSSD** — framework `NsdManager` only.
3. **Capacitor parity** — hard refresh on pull-to-refresh.

## Consequences

- [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts): Android → lazy `require('zeroconf-nsd')` + `watchAll(BROKER_SERVICE_TYPES)`; iOS → `react-native-zeroconf`. See [0006](./0006-ios-lazy-android-nsd-import.md), [0007](./0007-four-broker-types-zeroconf-nsd.md).
- [`react-native.config.js`](../../react-native.config.js): exclude `react-native-zeroconf` on Android.
- Rebuild dev client after native module changes.
- Test **iOS Release** on device, not Debug only — Release eagerly evaluates the JS bundle.
