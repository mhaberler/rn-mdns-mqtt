package com.balthazargronon.RCTZeroconf;

/** IPv4 CIDR membership test for discovery segment filtering. */
public final class Ipv4Subnet {
    private Ipv4Subnet() {}

    public static boolean contains(String cidr, String ip) {
        if (cidr == null || ip == null || ip.isEmpty()) return false;
        int slash = cidr.indexOf('/');
        if (slash <= 0) return false;

        String network = cidr.substring(0, slash);
        int prefix;
        try {
            prefix = Integer.parseInt(cidr.substring(slash + 1));
        } catch (NumberFormatException e) {
            return false;
        }
        if (prefix < 0 || prefix > 32) return false;

        long ipValue = parseIpv4(ip);
        long networkValue = parseIpv4(network);
        if (ipValue < 0 || networkValue < 0) return false;

        long mask = prefix == 0 ? 0 : (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
        return (ipValue & mask) == (networkValue & mask);
    }

    private static long parseIpv4(String value) {
        String[] parts = value.split("\\.");
        if (parts.length != 4) return -1;

        long result = 0;
        for (String part : parts) {
            int octet;
            try {
                octet = Integer.parseInt(part);
            } catch (NumberFormatException e) {
                return -1;
            }
            if (octet < 0 || octet > 255) return -1;
            result = (result << 8) | octet;
        }
        return result;
    }
}
