/** Phone IPv4 for subnet-aware broker pick. Not available until dev client rebuilt with expo-network. */
export async function getDeviceIPv4(): Promise<string | undefined> {
  return undefined;
}

export function clearDeviceIpCache() {
  /* no-op until expo-network is linked in dev client */
}
