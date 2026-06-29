# Lazy-load Android NSD module on iOS

**Status:** Accepted

## Context

[`zeroconf-nsd`](../../modules/zeroconf-nsd/) is an **Android-only** Expo module (`expo-module.config.json` → `"platforms": ["android"]`). iOS discovery uses `react-native-zeroconf` only ([0001](./0001-react-native-zeroconf.md), [0003](./0003-android-nsdmanager-module.md)).

After restoring the Android module, [`src/lib/zeroconf-adapter.ts`](../../src/lib/zeroconf-adapter.ts) used a **top-level** import:

```ts
import { watchAll, ... } from 'zeroconf-nsd';
```

That module's entry calls `requireNativeModule('ZeroconfNsd')` when evaluated. No iOS native module exists → **Release builds crashed on startup**. Debug often appeared fine because Metro defers evaluation; Release embeds a bundle that eagerly loads the import chain.

## Decision

1. **Never statically import** `zeroconf-nsd` from shared code used on iOS.
2. **Lazy `require('zeroconf-nsd')`** inside Android-only code paths in `zeroconf-adapter.ts` (`Platform.OS === 'android'`).
3. **Defer native init** in `modules/zeroconf-nsd/src/index.ts` — call `requireNativeModule` on first API use, not at module top level.

## Consequences

- iOS Release and Debug both start without touching `ZeroconfNsd`.
- Android behavior unchanged — module loads on first scan/watch.
- Platform split remains: adapter is one file; import discipline is the guardrail.
- Rebuild Release after JS changes (`bun run ios-device-release`); no native rebuild required for this fix alone.

## Verification

- iOS Release on physical device (`mahphone`): app launches, Scanner loads, Bonjour discovery works.
- Android Release on S928B dual-homed: unchanged — parallel WS/WSS watches still work.
