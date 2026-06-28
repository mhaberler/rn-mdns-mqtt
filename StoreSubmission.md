# Store Submission Pack — MQTT Scout RN

Parallel React Native edition. Bundle `com.haberlerm.rnmqttmdns`.

Forked from Capacitor `mdns-mqtt-vue3` store pack — update URLs and screenshots before submit.

## Apple App Store Connect

### App Review Notes

MQTT Scout RN is a developer/IoT utility for discovering MQTT brokers via Bonjour/mDNS and publishing/subscribing over MQTT. Native discovery uses NetService (iOS) and embedded mDNSResponder DNSSD (Android) via `react-native-zeroconf` — not a website wrapper. On Android, when the phone's hotspot AP is on, hotspot-segment brokers appear under **Hotspot** (Network-bound NSD). When WiFi client and hotspot are both active, upstream brokers appear under **Upstream WiFi**.

How to test:

1. Launch the app. Allow **Local Network** when prompted.
2. On **Scanner**, open **test.mosquitto.org (WSS)** (port 8081).
3. **Client** tab auto-connects; subscribes to `#`. Publish to `test/hello` to verify round-trip.
4. mDNS runs while foregrounded. **Refresh** clears and rescans. Empty LAN in review Wi‑Fi is expected.
5. No Hosts tab in v1.

No account, tracking, analytics, or data collection.

Privacy policy: `PRIVACY.md` in this repo.

### Pre-submission checklist

- [ ] Multicast Networking entitlement (iOS)
- [ ] Bump iOS build number per upload
- [ ] Privacy Policy URL in App Store Connect
- [ ] Screenshots: Scanner + Client round-trip
- [ ] `expo prebuild` + device test on real hardware (not Expo Go)

## Google Play Console

### Data Safety

- Data collected: **None**
- TLS in transit: **Yes** (WSS/MQTTS; LAN cleartext user-chosen)
- Permissions: INTERNET, network state, Wi‑Fi multicast, NEARBY_WIFI_DEVICES

### Pre-submission checklist

- [ ] Signed AAB via `eas build` or local Gradle release
- [ ] Bump `versionCode` each upload
- [ ] Privacy Policy URL in Play listing
- [ ] Test DNSSD discovery on physical Android (Galaxy, etc.)
- [ ] Test hotspot-only Android: enable phone hotspot, connect IoT device (no upstream WiFi) — **Hotspot** subsection shows broker
- [ ] Test dual-homed Android: WiFi client + hotspot — both Upstream WiFi and Hotspot subsections; hotspot clears when tethering off
