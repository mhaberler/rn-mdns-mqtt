# Dual DNSSD — Phase 0 findings

## Stock react-native-zeroconf (0.14.0) cannot do dual bound browse

1. **Two JS `Zeroconf()` instances fail** — `addDeviceListeners()` rejects a second instance (`RNZeroconf listeners already in place`). All events share one `DeviceEventEmitter` channel on `RNZeroconf`.

2. **One native `DnssdImpl` per DNSSD impl type** — `ZeroConfImplFactory` singleton. `scan()` calls `stop()` first, tearing down the only browse.

3. **Browse uses all interfaces** — `Rx2DnssdCommon.browse()` calls `mDNSSD.browse(0, DNSSD.ALL_INTERFACES, ...)`. Underlying mDNSResponder **supports per-interface browse** via `ifIndex` (`InternalDNSSD.browse(flags, ifIndex, ...)`).

4. **No Network / interface API** — `ZeroconfModule.scan(type, protocol, domain, implType)` has no bind parameter.

## SIGSEGV context (ADR 0002)

[`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts) documents embedded DNSSD SIGSEGV on rapid `stop()` → `scan()` while resolve callbacks are in flight. Mitigation today: long-lived browse + soft JS republish on refresh. Dual parallel browses must avoid stopping one browse while resolving on the same embedded DNSSD instance — use **per-key dispose** instead of global `stop()`.

## Exit

Proceed to Phase 1: patch `react-native-zeroconf` with `browseOnInterface`, multi-browse `DnssdImpl`, and network watching in `ZeroconfModule`.
