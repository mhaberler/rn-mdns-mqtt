# MQTT Scout RN

Discover MQTT brokers on your local network via Bonjour/mDNS, connect, publish, and subscribe. React Native port of [MQTT Scout](https://github.com/mhaberler/mdns-mqtt-vue3) (Capacitor/Vue), shipped as a separate app (`com.haberlerm.rnmqttmdns`).

Companion ESP32 firmware: [SensorPod](https://github.com/mhaberler/sensorpod) — PlatformIO project that runs a local MQTT broker (native TCP + WebSocket), advertises `_mqtt._tcp` and `_mqtt-ws._tcp` via mDNS, and publishes sensor topics. Designed to be discovered and exercised by this app.

Built with [Expo SDK 56](https://docs.expo.dev/versions/v56.0.0/) and requires a **development build** — native mDNS and TCP are not available in Expo Go.

## Features

- **Scanner** — browse for brokers advertising any of four Bonjour service types
- **Manual add** — enter host, port, type, and optional credentials
- **Test** — quick connect/publish/subscribe check before opening the client
- **Client** — publish and subscribe on a connected broker
- **Preferred broker** — persisted locally via AsyncStorage

### Supported broker types

| Bonjour type | Transport | Default port |
|--------------|-----------|--------------|
| `_mqtt-ws._tcp` | MQTT over WebSocket | 8080 |
| `_mqtt-wss._tcp` | MQTT over WebSocket + TLS | 8081 |
| `_mqtt._tcp` | Native MQTT | 1883 |
| `_secure-mqtt._tcp` | Native MQTTS | 8883 |

Discovered brokers trust the port from mDNS. Manual entry warns when type and port look mismatched (e.g. WS on 1883).

## Requirements

- Node.js 18+
- npm or [Bun](https://bun.sh)
- Xcode 16+ (iOS device or simulator)
- Android Studio / SDK (device or emulator)
- Physical device recommended for real mDNS and dual-network scenarios

## Setup

```bash
git clone https://github.com/mhaberler/rn-mdns-mqtt.git
cd rn-mdns-mqtt
npm install   # runs patch-package via postinstall
```

Patches under `patches/` modify `mqtt` and `react-native-tcp-socket` for React Native native TCP/TLS. Re-run `npm install` after pulling if patches change.

## Run

Start Metro:

```bash
npm start
```

Build and install a dev client (first time or after native changes):

```bash
# iOS simulator
npm run ios

# iOS physical device
npm run ios-device

# Android emulator
npm run android

# Android physical device
npm run android-device
```

Release builds on device:

```bash
npm run ios-device-release
npm run android-device-release
```

After native module or patch changes, regenerate native projects if needed:

```bash
npx expo prebuild --clean
```

## Project layout

```
src/
  app/              Expo Router screens (Scanner, Client)
  hooks/            useMqttDiscovery, useMqttConnection
  lib/              mDNS adapter, MQTT connect, broker host pick
modules/
  zeroconf-nsd/     Android NsdManager Expo module (lazy-loaded)
patches/            mqtt.js + react-native-tcp-socket patches
docs/adr/           Architecture decision records
```

## Architecture notes

### Discovery

| Platform | Backend | Behavior |
|----------|---------|----------|
| **iOS** | `react-native-zeroconf` (Bonjour) | Time-sliced browse across four types (15s initial slice, then 8s rotation). Requires Local Network permission. |
| **Android** | Local `zeroconf-nsd` module | Parallel `watchAll` for all four types. Handles dual-homed phones (upstream Wi‑Fi + hotspot AP). |

mDNS is **link-local**. Brokers on a different subnet than the phone (e.g. ESP on hotspot while the phone is on upstream Wi‑Fi) will not appear until both are on the same L2 domain.

The Android module is imported lazily so iOS Release builds do not load Android-only native code.

### MQTT client

All four broker types use **mqtt.js v5** with a unified opts-only connect path:

- **WS / WSS** — browser WebSocket transport (`global.WebSocket`)
- **MQTT / MQTTS** — patched native TCP via `react-native-tcp-socket`

Metro is configured to bundle the patched mqtt CJS build (`metro.config.js`), not the browser-only ESM bundle.

On dual-homed Android, native TCP routes outbound sockets through the Wi‑Fi interface that shares a subnet with the broker IP.

### Foreground-only scan

Discovery starts when the app is active and stops in background (`AppState`). Auto-connect and background MQTT pause/resume are deferred to a future release.

## Network tips

- **Same Wi‑Fi** — phone and broker on the same AP for reliable discovery.
- **Phone hotspot** — connect the IoT device to the phone’s hotspot; refresh the scanner after switching networks.
- **Stale entries** — tap Refresh after changing networks; old mDNS rows can linger briefly.
- **Self-assigned IPs (`169.254.x.x`)** — link-local addresses from a broker’s interface; usually not reachable. Prefer the routable LAN IP on the same subnet as the phone.

## ESP32 / embedded brokers

Reference firmware: **[SensorPod](https://github.com/mhaberler/sensorpod)** (ESP32-C6, PlatformIO). It advertises Bonjour services this app scans for and publishes hostname-prefixed sensor topics (e.g. `esp32c6-5B0A24/VL53L0X`).

Recommended port scheme (matches app defaults):

| Service | Port |
|---------|------|
| `_mqtt._tcp` | 1883 |
| `_secure-mqtt._tcp` | 8883 |
| `_mqtt-ws._tcp` | 8080 |
| `_mqtt-wss._tcp` | 8081 |

For WebSocket services, advertise TXT `path=/mqtt` when using that path.

SensorPod may ship with non-default WS ports (e.g. 8883); moving WS to **8080** avoids confusion with MQTTS and matches the table above.

## Documentation

- [SensorPod](https://github.com/mhaberler/sensorpod) — matching ESP32 broker firmware
- [CONTEXT.md](./CONTEXT.md) — product vocabulary and scope
- [docs/adr/](./docs/adr/) — architecture decisions (discovery, patches, four broker types)
- [PRIVACY.md](./PRIVACY.md) — privacy policy
- [StoreSubmission.md](./StoreSubmission.md) — App Store / Play Store notes

## License

MIT — see [LICENSE](./LICENSE).
