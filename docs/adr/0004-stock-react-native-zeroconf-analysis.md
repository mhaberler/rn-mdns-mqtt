# Stock react-native-zeroconf vs mqtt-zeroconf-nsd

Companion to [0003-android-nsdmanager-module.md](./0003-android-nsdmanager-module.md). Documents why we chose the local Expo module and when stock `react-native-zeroconf` would suffice.

## Status

**Superseded** — reverted to stock `react-native-zeroconf` (`ImplType.NSD`) per [0005](./0005-revert-stock-react-native-zeroconf.md).

## Short answer

Stock `react-native-zeroconf` v0.14.0 **already defaults to Android NsdManager** (`ImplType.NSD`). No patch is required to use NsdManager on Android.

The deleted `patches/react-native-zeroconf/` tree did **not** enable NsdManager — it enhanced the optional **DNSSD** backend (`ImplType.DNSSD`) with embedded mDNSResponder, per-interface binding, and `NetworkDiscoveryManager`. S928B SIGSEGV was in `libjdns_sd_embedded.so`, not in stock `NsdServiceImpl`.

Both the custom Expo module and stock NSD path call the same Android framework API.

## Stock package facts (npm 0.14.0)

| Fact | Detail |
|------|--------|
| Android default backend | `NsdServiceImpl` → `NsdManager` when `implType` is blank or `NSD` |
| JS default | `scan(..., implType = ImplType.NSD)` |
| Optional second backend | `DnssdImpl` + NDK-built `libjdns_sd_embedded.so` |
| Stock NSD behavior | Multicast lock, resolve-on-found, single active browse (new `scan()` calls `stop()` first) |
| TXT records | Included in stock `serviceInfoToMap` |

## What the old patch stack added

Per [0003](./0003-android-nsdmanager-module.md) and deleted `patches/`:

- Embedded DNSSD browse with per-interface binding
- Dual-leg upstream/hotspot discovery mode events
- **Not** “make NsdManager work” — NsdManager already existed in stock

The detour was choosing DNSSD for dual-homed control, then fighting native crashes. Capacitor and `mqtt-zeroconf-nsd` proved OS-managed NsdManager browse is enough on S928B dual-homed.

## Trade-offs: stock NSD vs mqtt-zeroconf-nsd

| Concern | Stock NSD (no patch) | Current mqtt-zeroconf-nsd |
|---------|----------------------|---------------------------|
| Patch required? | No — use `ImplType.NSD` only | N/A |
| Dual-homed flat list | Should work (same NsdManager; verified with custom module on S928B) | Proven on device |
| Parallel `_mqtt-ws` + `_mqtt-wss` | No — single listener; use iOS-style rotation | Yes — parallel watches (Capacitor parity) |
| DNSSD in APK | Yes — `.so` built even if never used | No — excluded via [`react-native.config.js`](../../react-native.config.js) |
| Native bridge count | One package, both platforms | Two backends (iOS zeroconf + Android module) |
| SIGSEGV risk | Low if never passing `ImplType.DNSSD` | None from DNSSD |
| Refresh | `scan()` clears JS cache; native stop+restart per scan | Capacitor stop → clear → start |

## When is a patch needed?

| Goal | Patch needed? |
|------|---------------|
| MQTT discovery via NsdManager on Android | **No** |
| Dual-interface DNSSD binding / segment UI | **Yes** — old patch path; caused crashes |
| Remove dead `libjdns_sd_embedded.so` from APK while keeping npm package | **Optional** — strip NDK build + DNSSD factory branch |
| Parallel WS+WSS browses without rotation | **Yes** — stock `NsdServiceImpl` is single-browse; Expo module adds multi-watch |

## If reverting to stock (not current decision)

1. Remove [`react-native.config.js`](../../react-native.config.js) Android exclusion and `mqtt-zeroconf-nsd` dependency
2. Simplify [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts) — unified `Zeroconf` on both platforms; **`ImplType.NSD` explicitly**, never DNSSD
3. Enable WS/WSS **rotation on Android** (same as iOS today)
4. Fresh `bun install` for pristine stock in `node_modules`
5. Re-run S928B verification matrix from ADR 0003
6. Optionally patch or fork to drop DNSSD native build (APK size / 16KB `.so`)

## Recommendation

- **Full circle is real**: stock NSD and `mqtt-zeroconf-nsd` both use `NsdManager`. The problem was DNSSD + patches, not “zeroconf can't do NSD.”
- **Keeping mqtt-zeroconf-nsd** (current): no DNSSD in APK, parallel WS/WSS watches, Capacitor API parity, controlled Android codepath.
- **Reverting to stock** is viable without patch if WS/WSS rotation on Android and shipping unused DNSSD `.so` are acceptable.

## Stale node_modules note

If `node_modules/react-native-zeroconf` still contains patched files (`NetworkDiscoveryManager.java`, discovery-mode ReactMethods) after the patch script was removed, run `bun install` to restore pristine npm 0.14.0. Android autolinking is disabled via `react-native.config.js`, so those files do not affect release builds today.
