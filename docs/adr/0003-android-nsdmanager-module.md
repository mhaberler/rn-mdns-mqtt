# Android NsdManager via Expo module

**Active** — restored after stock zeroconf failed dual-homed hotspot on S928B ([0005](./0005-revert-stock-react-native-zeroconf.md)).

Supersedes [0002-hybrid-android-discovery.md](./0002-hybrid-android-discovery.md) for Android discovery.

## Context

MQTT Scout RN shipped a patched `react-native-zeroconf` with **embedded mDNSResponder (DNSSD)** on Android: dual interface-bound browses, `NetworkDiscoveryManager`, and a large `patches/` tree applied on `postinstall`.

On Samsung Galaxy S928B (dual-homed: WiFi client + phone hotspot), embedded DNSSD caused **native SIGSEGV** in `libjdns_sd_embedded.so` during browse dispose, watchdog re-browse, and back-to-back resolves — even after serializing the resolve pipeline and removing hotspot rotation.

The Capacitor sibling (`mdns-mqtt-vue3`) uses **`@mhaberler/capacitor-zeroconf-nsd`** (Android `NsdManager`, single `watch` per service type) and **reliably discovers brokers on both upstream LAN and hotspot AP** on the same device.

ADR 0002 rejected NsdManager on Samsung AP based on an earlier spike (`onServiceFound` never fired on `swlan0`). Field evidence from the production Capacitor app supersedes that spike for this product.

## Decision

**Android:** local Expo module [`modules/zeroconf-nsd/`](../../modules/zeroconf-nsd/) — generic `NsdManager` browse/resolve via `watchAll(types, domain)` / `unwatchAll` / `close`. Parallel watches for all app-configured Bonjour types. See [0007](./0007-four-broker-types-zeroconf-nsd.md).

**iOS:** unchanged — stock `react-native-zeroconf` Bonjour with WS/WSS time-slice rotation.

**Remove from Android:** entire `patches/react-native-zeroconf/` DNSSD tree, `postinstall` patch script, `react-native-zeroconf` Android autolinking (drops `libjdns_sd_embedded.so`).

**UI:** flat discovered broker list on Android (Capacitor parity). No upstream/hotspot segment split.

## Why not keep DNSSD

| Issue | DNSSD patch | NsdManager module |
|-------|-------------|-------------------|
| Native crashes on S928B | SIGSEGV in embedded stack | Not observed in Capacitor production use |
| Maintenance | 8 patched Java files + postinstall | One Expo module, no node_modules mutation |
| Capacitor parity | Different stack, dual-leg complexity | Same API shape as Vue app |
| Play / 16KB | Embedded .so alignment concerns | Framework API only |

## Trade-offs

- **No per-interface browse** — OS picks network; matches Capacitor (no `Network.bindSocket` / `browseOnInterface`).
- **Android hostname** may be IP string, not `.local` SRV target (NsdManager limitation; same as Capacitor).
- **iOS/Android asymmetry** — two discovery backends; adapter hides this in JS.
- **Deaf browse recovery** — no DNSSD watchdog; refresh clears list and restarts watches (Capacitor pattern).

## Consequences

- [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts): platform split (Android → lazy `zeroconf-nsd`, iOS → `react-native-zeroconf`). Module is Android-only — static JS import crashes iOS Release ([0006](./0006-ios-lazy-android-nsd-import.md)).
- Delete [`src/lib/discovery-mode.ts`](../../src/lib/discovery-mode.ts), [`src/lib/zeroconf-native*.ts`](../../src/lib/zeroconf-native.ts).
- [`react-native.config.js`](../../react-native.config.js): exclude `react-native-zeroconf` on Android.
- Rebuild dev client after `npm install` (new native module).
- Update [`CONTEXT.md`](../../CONTEXT.md), [`StoreSubmission.md`](../../StoreSubmission.md).

## Verification

Release build on S928B dual-homed: flat list shows upstream + hotspot brokers; no `DNS-SDEmbedded` / `DnssdImpl` in logcat; refresh clears and repopulates; 5+ min soak without SIGSEGV.

## Alternatives considered

See [0004-stock-react-native-zeroconf-analysis.md](./0004-stock-react-native-zeroconf-analysis.md). Stock `react-native-zeroconf` v0.14.0 already ships an NsdManager backend (default on Android). We keep the local Expo module for parallel watches, no DNSSD in the APK, and Capacitor parity — not because stock NSD is unavailable without a patch.
