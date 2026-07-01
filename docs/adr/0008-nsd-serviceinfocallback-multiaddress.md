# NSD multi-address resolve via ServiceInfoCallback (API 34+)

**Active** — extends [0003-android-nsdmanager-module.md](./0003-android-nsdmanager-module.md).

## Context

The Android module [`NsdDiscoveryEngine`](../../modules/zeroconf-nsd/android/src/main/java/expo/modules/zeroconfnsd/NsdDiscoveryEngine.kt) resolved each found service with the deprecated `NsdManager.resolveService`. That path has two limits that matter for this product:

- **Single address.** Below API 34, `NsdServiceInfo` carries one `host` `InetAddress`. A broker advertising several IPs (common on dual-homed devices — upstream LAN + phone hotspot) surfaces only one, giving the `/24` subnet matcher in [`device-network.ts`](../../src/lib/device-network.ts) / [`broker-host.ts`](../../src/lib/broker-host.ts) fewer candidates.
- **Serialized, single-slot.** `resolveService` can resolve one service at a time on older Android. With four parallel watches (`_mqtt-ws`, `_mqtt-wss`, `_mqtt`, `_secure-mqtt`) resolving concurrently, calls can collide.

API 34 (Android 14) added `registerServiceInfoCallback` — a live subscription that yields the full A/AAAA list via `getHostAddresses()`, auto-updates as addresses change, and has no single-slot limit. `minSdk` is 24, so it cannot replace the legacy call, only augment it.

## Decision

**Version-split resolve, gated on `Build.VERSION.SDK_INT >= 34`:**

- **34+** — `registerServiceInfoCallback` per found service. Emit `added` on the first `onServiceUpdated`, `resolved` on every update (JS merges addresses). `jsonifyService` reads all `getHostAddresses()` into `ipv4Addresses`/`ipv6Addresses`.
- **24–33** — unchanged deprecated `resolveService`; single `host` address.

**Callback lifecycle:** registrations keyed `type + serviceName`, torn down on `onServiceLost`, `unwatch(type)` (all keys with that type prefix), and `close()`. `refreshDiscovery()` (stop→clear→restart) is the backstop for a callback leaked by an ungraceful broker disappearance.

**FAILURE_MAX_LIMIT retry:** `onStartDiscoveryFailed` re-posts the failed `watch` after 3 s, capped at 3 attempts per type; other error codes log only.

The JS contract is unchanged — the adapter and store already merge multi-address `resolved` events and prefer IPs over hostname.

## Trade-offs

- **Two resolve paths** to maintain until `minSdk` reaches 34.
- **N live callbacks** (one per found service) need disciplined teardown; leaks are bounded by Refresh, not reaped on a timer.
- **Addresses only** — NsdManager exposes no SRV-target `.local` hostname on either path. `hostname` stays best-effort from `InetAddress.hostName` (usually the IP). True `.local` names would require raw-socket A/AAAA parsing — out of scope.
- **Multi-address is 34+ only.** Pre-Android-14 devices keep single-address behavior; acceptable for the common single-homed case, and no raw sockets added.

## Consequences

- Only [`NsdDiscoveryEngine.kt`](../../modules/zeroconf-nsd/android/src/main/java/expo/modules/zeroconfnsd/NsdDiscoveryEngine.kt) changes; JS/adapter untouched.
- Rebuild dev client (native change) before testing.
- Deferred: active liveness/re-query for stale *presence* (34+ subscription already self-heals stale addresses; presence staleness stays on manual Refresh).

## Verification

- 34+ device, dual-homed: a broker advertising >1 IP surfaces >1 entry in `ipv4Addresses`; `pickConnectHost` selects the same-`/24` address. Single-homed broker unchanged.
- <34 device (emulator API 30): single address still resolves; no crash on the callback-absent path.
- Thrash Refresh to force `FAILURE_MAX_LIMIT`: watch recovers within ~3 s (logcat `ZeroconfNsd`), stops after 3 attempts if wedged.
- Background/foreground + Refresh repeatedly: no runaway `onServiceUpdated` after `close` (no leaked callbacks).
- iOS unchanged (`react-native-zeroconf`); no eager `zeroconf-nsd` import ([0006](./0006-ios-lazy-android-nsd-import.md)).
