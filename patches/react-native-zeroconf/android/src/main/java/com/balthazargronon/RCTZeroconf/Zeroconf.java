package com.balthazargronon.RCTZeroconf;

import com.facebook.react.bridge.ReadableMap;

public interface Zeroconf {

    void scan(String type, String protocol, String domain);

    void stop();

    void unregisterService(String serviceName);

    void registerService(String type, String protocol, String domain, String name, int port, ReadableMap txt);

    /** Android dual DNSSD: start network watching and interface-bound browses. */
    default void startDiscoveryWatching() {}

    /** Android dual DNSSD: stop all browses and network watching. */
    default void stopDiscoveryWatching() {}

    /** Android dual DNSSD: restart browses for current mode. */
    default void restartDiscoveryScan() {}

    /** Android dual DNSSD: none | hotspotOnly | dualHomed */
    default String getDiscoveryMode() {
        return "none";
    }
}
