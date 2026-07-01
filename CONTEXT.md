# MQTT Scout (React Native)

Parallel React Native implementation of the MQTT Scout developer utility — discover MQTT brokers via Bonjour/mDNS, connect over WebSocket, publish and subscribe. Sibling to the Capacitor/Vue app; separate store listing.

## Language

**MQTT Scout (Capacitor)**:
The existing Capacitor + Vue 3 app (`mdns-mqtt-vue3`), bundle `com.haberlerm.mqttmdns`. Remains live; not replaced by this port.
_Avoid_: Old app, legacy app

**MQTT Scout (RN)**:
This React Native app, bundle `com.haberlerm.rnmqttmdns`. Parallel product — same domain, separate listing.
Display name: **MQTT Scout RN** (differentiated from Capacitor sibling).
_Avoid_: rn-mdns-mqtt (repo/slug name only; not user-facing unless chosen)

**Broker**:
An MQTT endpoint the user can connect to — identified by host, port, and service type (WS, WSS, MQTT, or MQTTS via Bonjour types `_mqtt-ws._tcp`, `_mqtt-wss._tcp`, `_mqtt._tcp`, `_secure-mqtt._tcp`).
_Avoid_: Server, service (when meaning the MQTT endpoint specifically)

**Host**:
A `.local` machine on the LAN, aggregated from common Bonjour service advertisements — distinct from a **Broker**.
_Avoid_: Device (unless referring to the phone itself)

**Preferred broker**:
The user's chosen default broker, persisted locally. May be pre-configured, discovered, or manually entered.
_Avoid_: Favorite, default connection

**v1 scope**:
Scanner tab + MQTT Client tab only. Hosts tab deferred to v1.1.
Includes full Scanner features except auto-connect and background pause/resume (deferred to v1.1).
_Avoid_: MVP (too vague), full parity

**Android mDNS backend**:
Local Expo module `zeroconf-nsd` (renamed from `mqtt-zeroconf-nsd`) using Android `NsdManager`. Parallel watches for all configured Bonjour types; flat discovered list. Required for dual-homed hotspot + upstream on S928B (stock zeroconf rotation breaks hotspot resolve).
_Avoid_: Stock react-native-zeroconf rotation on Android for dual-homed use

**Address resolution (Android)**:
NsdManager yields **addresses, not a `.local` hostname**. On API 34+ resolution uses a live `registerServiceInfoCallback` returning the full A/AAAA list (multi-address, auto-updating); on 24–33 the deprecated `resolveService` returns a single address. True SRV-target `.local` names are unavailable without raw sockets (out of scope). `hostname` is best-effort; IP addresses are the connect payload. See ADR 0008.
_Avoid_: Expecting `.local` hostnames from NsdManager; assuming multi-address below API 34

**Stock react-native-zeroconf (Android NSD)**:
Default Android backend in npm package is `NsdManager`, but single-browse + WS/WSS rotation fails dual-homed hotspot on S928B. See ADR 0005.
_Avoid_: Assuming stock zeroconf matches Capacitor dual-homed behavior on Samsung

**iOS mDNS backend**:
Bonjour / NetService via `react-native-zeroconf`.
_Avoid_: Replacing iOS Bonjour with NsdManager; static import of Android-only `zeroconf-nsd` (crashes iOS Release — see ADR 0006)

**Discovery segment** (deprecated on Android):
Which L2 multicast domain a broker was found on: **upstream WiFi** or **hotspot**. Android uses a flat list like Capacitor; segment tagging is not used in v1 RN.
_Avoid_: Network, interface (in user-facing copy)

**Upstream WiFi segment**:
Brokers on the LAN the phone joins as a WiFi client.
_Avoid_: External WiFi, primary network

**Hotspot segment**:
Brokers on devices connected to the phone's hotspot/AP.
_Avoid_: Tether network, AP clients

**mDNS library (iOS)**:
`react-native-zeroconf` (community npm package). Requires Expo dev build / prebuild — not Expo Go.

**mDNS library (Android)**:
`zeroconf-nsd` local Expo module (`NsdManager`). Android-only native module; app passes service-type array via `watchAll`. Loaded via lazy `require` in [`zeroconf-adapter.ts`](src/lib/zeroconf-adapter.ts). Requires Expo dev build / prebuild — not Expo Go.
_Avoid_: Stock react-native-zeroconf rotation on Android when dual-homed; top-level import of `zeroconf-nsd` from shared JS

**MQTT client**:
`mqtt` v5 (mqtt.js) over WebSocket (WS/WSS) or native TCP (MQTT/MQTTS via `react-native-tcp-socket` stream). Same library and connection logic as Capacitor app for WS; native TCP added for `_mqtt._tcp` / `_secure-mqtt._tcp` brokers.
_Avoid_: Native MQTT modules that replace mqtt.js entirely

**UI**:
React Native StyleSheet, port Capacitor layout and colors. No NativeWind.
_Avoid_: Tailwind/NativeWind, full UI redesign

**Store docs**:
Fork and adapt from Capacitor app (`PRIVACY.md`, `StoreSubmission.md`) — RN repo owns its URLs and bundle-specific notes.
_Avoid_: Shared single privacy URL across both apps

**Persistence**:
`@react-native-async-storage/async-storage` for preferred broker and manual brokers — plain JSON, Capacitor Preferences parity.
_Avoid_: expo-secure-store (unless credentials handling changes later)

**Platform targets (v1)**:
iOS and Android only. No web build.
_Avoid_: Degraded web mode, Expo web

**Shared state**:
Module-scope singletons + custom hooks — direct port of Capacitor composable pattern (`useMqttDiscovery`, `useMqttConnection`, etc.).
_Avoid_: Zustand, React Context providers (unless hooks prove insufficient)

**Navigation (v1)**:
Two tabs: Scanner | Client. Client driven by singleton `connectedBroker`; empty state if never connected (no localhost fallback).
_Avoid_: Defaulting to localhost:8883

**mDNS lifecycle (v1)**:
Foreground-only scan via `AppState` — start on active, stop on background. Required in v1.
**MQTT lifecycle (v1.1)**: Auto-connect, pause/resume on background — deferred.

## Example dialogue

> **Dev:** Does the RN app replace the Capacitor one?
> **Expert:** No — parallel listing under `com.haberlerm.rnmqttmdns`. Capacitor stays.
>
> **Dev:** User picks a row on Scanner — is that a Host or a Broker?
> **Expert:** Broker. Hosts tab lists machines; Scanner lists MQTT endpoints.
