# Use react-native-zeroconf for mDNS discovery

MQTT Scout RN discovers MQTT brokers via Bonjour/mDNS on iOS and Android. The Capacitor sibling uses `@mhaberler/capacitor-zeroconf-nsd`, which we own and already ship in production. For the React Native port we chose the community package **`react-native-zeroconf`** (v0.14.x) instead of wrapping our Capacitor plugin or adopting newer RN-specific libraries.

On **Android**, scans use the **DNSSD** backend (embedded mDNSResponder), not Android `NsdManager` (NSD). On **iOS**, the library uses Bonjour / NetService. Discovery requires an Expo dev build (prebuild); it does not run in Expo Go.

## Considered options

| Option | Why not |
|--------|---------|
| **Expo module wrapping `@mhaberler/capacitor-zeroconf-nsd`** | Best API parity with the Vue app, but upfront module work before any UI ships. Deferred unless community libraries fail on real devices. |
| **`@inthepocket/react-native-service-discovery`** | Clean Turbo Module API and close `Service` shape to our Capacitor plugin (including TXT records). Android is **NSD only** — no DNSSD — so it conflicts with the Android 15+ / cross-device reliability goal. |
| **`@dawidzawada/bonjour-zeroconf`** | Modern Nitro Modules stack and built-in iOS local-network permission helpers. **`ScanResult` has no TXT record**, which breaks WebSocket path resolution (`txt.path` defaults to `/mqtt` in our MQTT client). Snapshot-based results, not per-service events. Small install base. |

## Why react-native-zeroconf

1. **Android DNSSD** — only evaluated option with an embedded mDNSResponder path; documented 16KB page alignment for Google Play (Android 15+).
2. **TXT records** — needed for `buildConnectUrl` (`broker.txtRecord?.path || '/mqtt'`).
3. **Parallel scans** — separate `scan('mqtt-ws', 'tcp')` and `scan('mqtt-wss', 'tcp')` matches our v1 Scanner (and future Hosts tab) model.
4. **Install base** — ~30k weekly npm downloads vs hundreds for alternatives; long project history with recent maintenance (0.14.0, Dec 2025).

## Consequences

- Write a thin **adapter** mapping `found` / `resolved` / `remove` events to our existing `ServiceEntry` model (Capacitor uses `added` / `resolved` / `removed`; we already treat `removed` as unreliable and clear on Refresh).
- Configure **iOS** `NSBonjourServices` and `NSLocalNetworkUsageDescription`; request multicast entitlement for App Store.
- Configure **Android** multicast / nearby-WiFi permissions and `usesCleartextTraffic` for LAN brokers (same as Capacitor).
- Always pass `'DNSSD'` as the Android implementation on `scan()` / `stop()` — do not use default NSD.
- If DNSSD or event semantics fail on target devices (Galaxy S24/S10/A15, iPhone), reassess — first fallback is wrapping our Capacitor native code, not switching to NSD-only libraries.
