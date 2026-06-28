# Dual DNSSD Android discovery

When an Android phone shares a **hotspot AP**, mDNS on connected IoT devices is link-local to the AP interface (`swlan0`, `ap0`, etc.). A single DNSSD browse bound to upstream WiFi (`wlan0`) or `ALL_INTERFACES` misses hotspot-segment brokers.

When the phone is also a **WiFi client** (dual-homed), one browse leg only reliably sees upstream LAN brokers unless a second leg binds to the AP interface.

## Decision

Run **two interface-bound DNSSD browse clients** via a patched `react-native-zeroconf` (embedded mDNSResponder), not a separate NSD/JmDNS module:

| Mode | Condition | Upstream leg | Hotspot leg |
|------|-----------|--------------|-------------|
| `none` | Hotspot off | DNSSD on `wlan0` or `ALL_INTERFACES` | — |
| `hotspotOnly` | AP on, no upstream WiFi STA | — | DNSSD on AP ifIndex |
| `dualHomed` | AP on + upstream WiFi STA | DNSSD on `wlan0` ifIndex | DNSSD on AP ifIndex |

`NetworkDiscoveryManager` watches `ConnectivityManager` WiFi networks, detects hotspot interfaces by name prefix (`swlan0`, `ap0`, …), and drives browse start/stop. Each resolve carries native `browseKey` (`upstream` | `hotspot`); JS maps that to `discoverySegment`.

Merge results in Scanner under **Upstream WiFi** and **Hotspot**. Purge hotspot brokers when tethering stops (`RNZeroconfHotspotPurged`). Show **Scanning hotspot…** while hotspot browse is active but empty.

## Patch (not fork)

Stock `react-native-zeroconf` 0.14.x cannot bind browse to an interface or run two parallel browses. We ship sources under `patches/react-native-zeroconf/` and copy them into `node_modules` on `postinstall` (`scripts/apply-zeroconf-patch.sh`).

Key native changes:

- `browseOnInterface(type, domain, ifIndex)` on embedded DNSSD
- Multi-browse `DnssdImpl` with per-leg dispose (no global `stop()` during refresh)
- `Ipv4Subnet` filter so cross-interface cache leaks (e.g. upstream `10.100.100.x` on hotspot leg) are dropped
- `synchronized` `DNSSDEmbedded.init()` so dual browse startup does not JNI-crash
- Hotspot **watchdog**: force re-browse on AP ifIndex when no resolve and no browse callback for 20s (15s poll; aligns with typical ESP re-announce)

## Why not alternatives

| Option | Why not |
|--------|---------|
| **Android `NsdManager` on AP network** | Samsung `swlan0`: browse starts but `onServiceFound` never fires. |
| **JmDNS bound to AP interface** | Worked intermittently on S928B; separate stack from upstream DNSSD; removed in favor of unified patch. |
| **Dual JS `Zeroconf()` instances** | Library singleton — second instance rejected; one native `DnssdImpl`. |
| **NSD-only primary scan** | Conflicts with ADR 0001 Android 15+ / Play reliability goal for upstream. |
| **Network picker UI** | User chose merged list without manual segment selection. |
| **Segment-aware MQTT socket binding** | Deferred; OS routes by destination IP unless field tests fail. |

## Known limitations

- **Samsung AP mDNS is flaky.** Interface-bound hotspot browse may go deaf; watchdog force re-browse usually recovers within ~20s. Worst case: JmDNS fallback on hotspot only (deferred — Phase 5 Capacitor eval).
- **Cross-leg cache:** Embedded DNSSD on AP ifIndex still hears some upstream PTRs; subnet filter prevents UI pollution.
- **Rapid stop→browse** on one embedded instance caused SIGSEGV historically; mitigated by long-lived per-key browses and staggered hotspot start — not eliminated.

## Consequences

- `patches/react-native-zeroconf/` + `postinstall` apply script — rebuild native after `npm install`.
- `ServiceEntry.discoverySegment`: `'upstream' | 'hotspot'`.
- Store keys include segment so same service name on both LANs can coexist.
- Removed `modules/hotspot-mdns` Expo module (NSD and JmDNS paths).
- iOS unchanged — single Bonjour browse via stock zeroconf.

## Device validation

Samsung SM-S928B dual-homed matrix: see [`docs/spikes/dual-dnssd-phase3-matrix.md`](../spikes/dual-dnssd-phase3-matrix.md). Scenarios 3–5 and 7 pass; upstream-only, hotspot-only, and hotspot-off purge need manual toggles.

## References

- [0001-react-native-zeroconf.md](./0001-react-native-zeroconf.md)
- [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts)
- [`src/lib/discovery-mode.ts`](../../src/lib/discovery-mode.ts)
- [`patches/react-native-zeroconf/`](../../patches/react-native-zeroconf/)
- [`docs/spikes/dual-dnssd-phase0-findings.md`](../spikes/dual-dnssd-phase0-findings.md)
