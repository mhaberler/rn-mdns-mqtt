import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isExpoGo } from '@/lib/native-modules';

/** Space for Expo Go's floating project chip (top-right). */
export const EXPO_GO_TOP_CHROME = 52;
/** Horizontal clearance so header actions don't sit under the chip. */
export const EXPO_GO_RIGHT_CHROME = 108;

export function useScreenInsets() {
  const insets = useSafeAreaInsets();
  const expoGo = isExpoGo();

  return {
    paddingTop: insets.top + (expoGo ? EXPO_GO_TOP_CHROME : 8),
    paddingBottom: Math.max(insets.bottom, 8),
    paddingLeft: insets.left + 12,
    paddingRight: insets.right + 12 + (expoGo ? EXPO_GO_RIGHT_CHROME : 0),
    insets,
    isExpoGo: expoGo,
  };
}
