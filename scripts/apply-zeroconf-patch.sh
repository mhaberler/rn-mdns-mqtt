#!/usr/bin/env sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/node_modules/react-native-zeroconf"
PATCH="$ROOT/patches/react-native-zeroconf"

if [ ! -d "$PKG" ]; then
  echo "apply-zeroconf-patch: react-native-zeroconf not installed, skipping"
  exit 0
fi

echo "Applying react-native-zeroconf dual-DNSSD patch..."

cp "$PATCH/android/src/main/java/com/balthazargronon/RCTZeroconf/NetworkDiscoveryManager.java" \
  "$PKG/android/src/main/java/com/balthazargronon/RCTZeroconf/"

cp "$PATCH/android/src/main/java/com/balthazargronon/RCTZeroconf/Ipv4Subnet.java" \
  "$PKG/android/src/main/java/com/balthazargronon/RCTZeroconf/"

cp "$PATCH/android/src/main/java/com/balthazargronon/RCTZeroconf/Zeroconf.java" \
  "$PKG/android/src/main/java/com/balthazargronon/RCTZeroconf/"

cp "$PATCH/android/src/main/java/com/balthazargronon/RCTZeroconf/ZeroconfModule.java" \
  "$PKG/android/src/main/java/com/balthazargronon/RCTZeroconf/"

cp "$PATCH/android/src/main/java/com/balthazargronon/RCTZeroconf/rx2dnssd/DnssdImpl.java" \
  "$PKG/android/src/main/java/com/balthazargronon/RCTZeroconf/rx2dnssd/"

cp "$PATCH/android/src/main/java/com/github/druk/rx2dnssd/Rx2Dnssd.java" \
  "$PKG/android/src/main/java/com/github/druk/rx2dnssd/"

cp "$PATCH/android/src/main/java/com/github/druk/rx2dnssd/Rx2DnssdCommon.java" \
  "$PKG/android/src/main/java/com/github/druk/rx2dnssd/"

cp "$PATCH/android/src/main/java/com/github/druk/dnssd/DNSSDEmbedded.java" \
  "$PKG/android/src/main/java/com/github/druk/dnssd/"

echo "react-native-zeroconf patch applied."
