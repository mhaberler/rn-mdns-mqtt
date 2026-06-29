# Four Bonjour broker types, generic zeroconf-nsd, native TCP connect

**Status:** Accepted

## Context

MQTT Scout RN v1 shipped with two Bonjour types (`_mqtt-ws._tcp`, `_mqtt-wss._tcp`) and WebSocket-only `mqtt.js` connects. Android discovery used local Expo module `mqtt-zeroconf-nsd` with per-type `watch`/`unwatch` calls.

Users need native MQTT brokers advertised as `_mqtt._tcp` and `_secure-mqtt._tcp`, with full Scanner → Test → Client flow. The discovery module should be protocol-agnostic (service types passed from the app).

## Decision

### Bonjour types (all first-class Brokers)

| Bonjour type | Transport | Default port |
|--------------|-----------|--------------|
| `_mqtt-ws._tcp` | WebSocket | 8080 |
| `_mqtt-wss._tcp` | WebSocket + TLS | 8081 |
| `_mqtt._tcp` | Native MQTT | 1883 |
| `_secure-mqtt._tcp` | Native MQTT + TLS | 8883 |

- **iOS:** equal 4-slot time-sliced rotation (15s initial + 8s slices); all four in `NSBonjourServices`.
- **Android:** parallel watches for all four via batch API.
- **Manual add:** four-type picker; smart port defaults when type changes (only if port still matches previous type default).
- **TLS:** verify-cert toggle for WSS and MQTTS, default on.

### Rename discovery module

| Layer | Old | New |
|-------|-----|-----|
| Folder / package | `mqtt-zeroconf-nsd` | `zeroconf-nsd` |
| Native module | `MqttZeroconfNsd` | `ZeroconfNsd` |

Batch-only native API: `watchAll(types[], domain)`, `unwatchAll(types[], domain)`, `close()`. App owns `BROKER_SERVICE_TYPES`; module has no MQTT knowledge.

Lazy `require('zeroconf-nsd')` on Android only ([0006](./0006-ios-lazy-android-nsd-import.md)).

### Native TCP connect (Kelvin patch stack)

Native MQTT/MQTTS uses **patched `mqtt.js`** + `react-native-tcp-socket`, proven in the Kelvin RN app. Patches applied via `patch-package` on `postinstall` (distinct from the removed zeroconf DNSSD postinstall in [0003](./0003-android-nsdmanager-module.md)):

- **`patches/mqtt+5.15.1.patch`** — `polypipe` fallback (RN socket has no `.pipe()`); register tcp/tls builders on React Native; wire `tcp.js`/`tls.js` to `react-native-tcp-socket`; WS proxy guards.
- **`patches/react-native-tcp-socket+6.4.1.patch`** — queue `write()` while TCP is `_pending` (mqtt.js sends CONNECT before connect event).
- **`package.json` `react-native` field** — Metro aliases `net`/`tls` → `react-native-tcp-socket`.

All four broker types connect via **opts-only** `mqtt.connect({ protocol, host, port, path?, rejectUnauthorized? })` — no URL-string parsing (removed by mqtt patch). Display URLs still built in [`src/lib/mqtt-url.ts`](../../src/lib/mqtt-url.ts). Connect host is raw IP/hostname (IPv6 brackets only in display URLs).

## Consequences

- [`src/lib/service-type.ts`](../../src/lib/service-type.ts): `BROKER_SERVICE_TYPES`, transport helpers, `mqttProtocolForType`.
- [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts): passes type array to `watchAll`.
- [`src/lib/mqtt-connect.ts`](../../src/lib/mqtt-connect.ts): `buildConnectOptions` + unified `mqtt.connect(opts)` for all types.
- [`patches/`](../../patches/): mqtt + react-native-tcp-socket Kelvin-derived patches.
- [`modules/zeroconf-nsd/`](../../modules/zeroconf-nsd/): generic NsdManager module.
- Rebuild dev client after patch stack + `react-native-tcp-socket` (`prebuild --clean` both platforms).

## Alternatives considered

- **Stock zeroconf for 4 types on Android** — rotation breaks dual-homed hotspot ([0005](./0005-revert-stock-react-native-zeroconf.md)).
- **Discovery-only for native types** — rejected; full Broker parity required.
- **Replace mqtt.js with native MQTT module** — rejected; keep one client path for WS and TCP.
- **Custom `MqttClient` streamBuilder** — rejected after iOS connect failures; Kelvin patch stack is proven.

## Verification

- Android S928B dual-homed: four parallel watches; flat list.
- iOS Release: four-type rotation; Local Network permission.
- Native MQTT broker: connect/test on `_mqtt._tcp` / `_secure-mqtt._tcp`.
