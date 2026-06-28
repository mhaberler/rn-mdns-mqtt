# Hybrid Android discovery (DNSSD + hotspot NSD)

When an Android phone shares a **hotspot AP**, mDNS on connected IoT devices is link-local to the AP interface. DNSSD via `react-native-zeroconf` typically binds to the wrong interface and misses hotspot-segment brokers.

When the phone is also a **WiFi client** (dual-homed), a single DNSSD browse only sees upstream LAN brokers; hotspot-segment brokers remain invisible without a second leg.

## Decision

Run Network-bound **NSD** via local Expo module `hotspot-mdns` whenever the phone's hotspot AP is active:

| Mode | Condition | Upstream leg | Hotspot leg |
|------|-----------|--------------|-------------|
| `none` | Hotspot off | DNSSD | — |
| `hotspotOnly` | AP on, no upstream WiFi STA | DNSSD | NSD on AP network |
| `dualHomed` | AP on + upstream WiFi STA | DNSSD (always) | NSD on AP network |

Merge results in Scanner under DISCOVERED subsections **Upstream WiFi** and **Hotspot**. Purge hotspot brokers immediately when tethering stops. Show **Scanning hotspot…** while hotspot NSD is active but empty.

## Why not alternatives

| Option | Why not |
|--------|---------|
| **Dual DNSSD** on two interfaces | Existing SIGSEGV on rapid stop→browse in embedded DNSSD; parallel sessions increase crash risk. |
| **NSD-only** | Conflicts with ADR 0001 Android 15+ / Play reliability goal for primary upstream scan. |
| **Network picker UI** | User chose merged list without manual segment selection. |
| **Segment-aware MQTT socket binding** | Deferred; OS routes by destination IP unless field tests fail. |

## Consequences

- Local Expo module `modules/hotspot-mdns` — Android only; iOS unchanged.
- `ServiceEntry.discoverySegment`: `'upstream' | 'hotspot'` for discovered brokers.
- Store keys include segment so same name on both LANs can coexist.
- Amend ADR 0001: DNSSD remains primary upstream leg when not dual-homed; NSD supplements hotspot always when AP is on.

## References

- [0001-react-native-zeroconf.md](./0001-react-native-zeroconf.md)
- [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts)
- [`modules/hotspot-mdns/`](../../modules/hotspot-mdns/)
