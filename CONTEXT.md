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
An MQTT endpoint the user can connect to — identified by host, port, and service type (WS/WSS).
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

**mDNS library**:
`react-native-zeroconf` (community npm package). Requires Expo dev build / prebuild — not Expo Go.
_Avoid_: Capacitor zeroconf plugin, custom Expo module (deferred unless library fails)

**Android mDNS backend**:
Patched `react-native-zeroconf` with embedded mDNSResponder (DNSSD). Upstream WiFi uses interface-bound or `ALL_INTERFACES` browse. When hotspot AP is on, a second DNSSD browse binds to the AP interface (`swlan0` / etc.) via `NetworkDiscoveryManager`. Dual-homed runs both browses in parallel; resolves tagged `browseKey` → `discoverySegment`. Patch applied on `postinstall` (`patches/react-native-zeroconf/`).
_Avoid_: Replacing DNSSD with NSD globally; Capacitor NSD-only default; Expo Go (dev client required)

**Discovery segment**:
Which L2 multicast domain a discovered broker was found on: **upstream WiFi** or **hotspot**. Distinct from **Broker source** (`discovered` / `manual` / `preconfigured`).
_Avoid_: Network, interface (in user-facing copy)

**Upstream WiFi segment**:
Brokers on the LAN the phone joins as a WiFi client.
_Avoid_: External WiFi, primary network

**Hotspot segment**:
Brokers on devices connected to the phone's hotspot/AP.
_Avoid_: Tether network, AP clients

**iOS mDNS backend**:
Bonjour / NetService (platform default via `react-native-zeroconf`).

**MQTT client**:
`mqtt` v5 (mqtt.js) over WebSocket — same library and connection logic as Capacitor app.
_Avoid_: Native MQTT modules, hand-rolled protocol

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
