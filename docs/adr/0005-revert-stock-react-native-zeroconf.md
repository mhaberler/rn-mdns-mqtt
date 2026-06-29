# Revert Android to stock react-native-zeroconf (NSD)

**Superseded — stock path reverted on Android.** See [0003](./0003-android-nsdmanager-module.md) (restored).

## Outcome (S928B dual-homed, 2026-06-29)

Stock `react-native-zeroconf` with WS/WSS **rotation** broke hotspot ESP discovery:

- System `MdnsDiscoveryManager` saw `esp32-4483D8` on hotspot interface `null/80` (`10.122.185.211`)
- App logged `On Service Found` then **rotation stop/start ~1.5s later** killed resolve before `RNZeroconfResolved`
- Upstream brokers on `100/46` still appeared; hotspot segment did not reach JS list

Parallel `mqtt-zeroconf-nsd` watches (no rotation stop) had shown both segments reliably on same device.

## Original decision (historical)

[0003](./0003-android-nsdmanager-module.md) added local Expo module `mqtt-zeroconf-nsd` for Capacitor-parity parallel NsdManager watches and to keep embedded DNSSD out of the APK.

[0004](./0004-stock-react-native-zeroconf-analysis.md) established that stock `react-native-zeroconf` v0.14.0 **already defaults to NsdManager** on Android — the deleted DNSSD patch stack was a separate detour, not a prerequisite for NSD.

## Decision

**Both platforms:** `react-native-zeroconf` v0.14.x.

**Android:** stock `NsdServiceImpl` via `ImplType.NSD` only — **never** `ImplType.DNSSD`.

**WS + WSS:** time-sliced rotation on both iOS and Android (single active browse; stock `NsdServiceImpl` cannot parallel-watch two types).

**Remove:** `modules/mqtt-zeroconf-nsd/`, [`react-native.config.js`](../../react-native.config.js) Android autolinking exclusion.

## Trade-offs vs mqtt-zeroconf-nsd (0003)

| Topic | Stock NSD (this ADR) | mqtt-zeroconf-nsd (0003) |
|-------|----------------------|--------------------------|
| Parallel WS+WSS | Rotation (8s slices) | Parallel watches |
| DNSSD in APK | Yes (unused `.so` still built) | No |
| Native bridges | One npm package | iOS zeroconf + Android Expo module |
| Maintenance | Upstream package | Local Kotlin module |

## Consequences

- Unified [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts) — no platform split.
- Rebuild dev client after `bun install` (react-native-zeroconf autolinks on Android again).
- Re-run S928B verification matrix from ADR 0003.

## Verification

Release build on S928B dual-homed: flat list shows upstream + hotspot brokers; refresh clears and repopulates; confirm `ImplType.NSD` in use (no intentional DNSSD calls). Note: `libjdns_sd_embedded.so` may still ship unused — optional future patch to strip NDK build.
