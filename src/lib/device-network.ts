import { Platform } from 'react-native';

  /** Samsung/Android dual-WiFi: phone hotspot client subnet (swlan0). */
function preferHotspotPhoneIp(ips: string[], remoteHost?: string): string | undefined {
  if (remoteHost) {
    const onSubnet = ips.find((ip) => onSameSubnet24(ip, remoteHost));
    if (onSubnet) return onSubnet;
  }
  const iphoneHotspot = ips.find((ip) => ip.startsWith('172.20.10.'));
  if (iphoneHotspot) return iphoneHotspot;
  const espAp = ips.find((ip) => ip.startsWith('192.168.4.'));
  if (espAp) return espAp;
  const androidHotspot = ips.find((ip) => ip.startsWith('10.122.185.'));
  if (androidHotspot) return androidHotspot;
  return ips[0];
}

function subnet24(ip: string): string | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function onSameSubnet24(a: string, b: string): boolean {
  const subnetA = subnet24(a);
  const subnetB = subnet24(b);
  return !!subnetA && subnetA === subnetB;
}

/** iPhone Personal Hotspot bind when phone IP unavailable. */
function inferIphoneHotspotBind(remoteHost: string): string | undefined {
  const match = remoteHost.match(/^172\.20\.10\.(\d{1,3})$/);
  if (match && match[1] !== '1') return '172.20.10.1';
  return undefined;
}

async function getNetInfoIPv4(): Promise<string | undefined> {
  try {
    const NetInfo = require('@react-native-community/netinfo').default as typeof import('@react-native-community/netinfo').default;
    const state = await NetInfo.fetch();
    const details = state.details as { ipAddress?: string | null } | null;
    return details?.ipAddress?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getAndroidWifiIPv4Addresses(): Promise<string[]> {
  try {
    const { getWifiIPv4Addresses } = require('zeroconf-nsd') as typeof import('zeroconf-nsd');
    return await getWifiIPv4Addresses();
  } catch {
    return [];
  }
}

async function getAndroidLocalIPv4ForRemote(remoteHost: string): Promise<string | undefined> {
  try {
    const { getLocalIPv4ForRemote } = require('zeroconf-nsd') as typeof import('zeroconf-nsd');
    const ip = await getLocalIPv4ForRemote(remoteHost);
    return ip?.trim() || undefined;
  } catch {
    return undefined;
  }
}

let cachedDeviceIp: string | undefined;
let cachedForRemote: string | undefined;

/**
 * Phone IPv4 for subnet-aware broker pick and native MQTT bind.
 * Pass remoteHost (broker IP) on dual‑homed Android so outbound TCP uses the matching Wi‑Fi iface.
 */
export async function getDeviceIPv4(remoteHost?: string): Promise<string | undefined> {
  if (remoteHost && cachedForRemote === remoteHost && cachedDeviceIp) {
    return cachedDeviceIp;
  }

  let ip: string | undefined;

  if (Platform.OS === 'android') {
    if (remoteHost) {
      ip = await getAndroidLocalIPv4ForRemote(remoteHost);
    }
    if (!ip) {
      const addresses = await getAndroidWifiIPv4Addresses();
      if (remoteHost) {
        ip = addresses.find((candidate) => onSameSubnet24(candidate, remoteHost));
      }
      if (!ip) {
        ip = preferHotspotPhoneIp(addresses, remoteHost);
      }
    }
  } else if (Platform.OS === 'ios') {
    if (remoteHost) {
      ip = inferIphoneHotspotBind(remoteHost);
    }
    if (!ip) {
      ip = await getNetInfoIPv4();
    }
    if (!ip && remoteHost) {
      ip = inferIphoneHotspotBind(remoteHost);
    }
  }

  if (ip) {
    cachedDeviceIp = ip;
    cachedForRemote = remoteHost;
  }
  return ip;
}

export function clearDeviceIpCache() {
  cachedDeviceIp = undefined;
  cachedForRemote = undefined;
}
