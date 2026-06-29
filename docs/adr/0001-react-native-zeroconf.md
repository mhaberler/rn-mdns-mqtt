# Use react-native-zeroconf for mDNS discovery

MQTT Scout RN discovers MQTT brokers via Bonjour/mDNS. Platform backends differ:

| Platform | Backend |
|----------|---------|
| **iOS** | `react-native-zeroconf` v0.14.x — Bonjour / NetService |
| **Android** | Local Expo module [`mqtt-zeroconf-nsd`](../../modules/mqtt-zeroconf-nsd/) — `NsdManager` (Capacitor parity). See [0003-android-nsdmanager-module.md](./0003-android-nsdmanager-module.md). |

Discovery requires an Expo dev build (prebuild); it does not run in Expo Go.

## Considered options (original Android — superseded for Android)

| Option | Why not (Android) |
|--------|-------------------|
| **Embedded DNSSD via patched react-native-zeroconf** | SIGSEGV on Samsung S928B; heavy patch maintenance. **Removed** — see ADR 0003. |
| **`@inthepocket/react-native-service-discovery`** | NSD-only Turbo Module; no iOS Bonjour parity with our adapter. |
| **`@dawidzawada/bonjour-zeroconf`** | No TXT in scan results. |

## Why react-native-zeroconf (iOS)

1. **TXT records** — `buildConnectUrl` uses `txt.path` (default `/mqtt`).
2. **Bonjour** — platform-native on iOS; `NSBonjourServices` + local network permission.
3. **WS + WSS** — rotate `_mqtt-ws` and `_mqtt-wss` scans on an 8s interval (one browse at a time on iOS).

## Why mqtt-zeroconf-nsd (Android)

1. **Production-proven** on same devices as Capacitor sibling (`@mhaberler/capacitor-zeroconf-nsd`).
2. **No embedded .so** — framework `NsdManager` only; avoids DNSSD crash class.
3. **Capacitor parity** — parallel `_mqtt-ws` + `_mqtt-wss` watches; hard refresh on pull-to-refresh.

## Consequences

- Thin **adapter** ([`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts)) maps discovery events to `ServiceEntry`.
- **iOS:** `NSBonjourServices`, `NSLocalNetworkUsageDescription`, multicast entitlement.
- **Android:** Wi‑Fi multicast permissions (already in `app.json`); `react-native-zeroconf` excluded from Android autolinking via [`react-native.config.js`](../../react-native.config.js).
- Rebuild dev client after adding/updating `mqtt-zeroconf-nsd`.
- Dual-homed DNSSD design ([0002](./0002-hybrid-android-discovery.md)) **superseded on Android** by ADR 0003.
