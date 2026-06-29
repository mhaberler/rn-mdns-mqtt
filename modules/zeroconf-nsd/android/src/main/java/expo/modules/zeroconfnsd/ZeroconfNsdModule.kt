package expo.modules.zeroconfnsd

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ZeroconfNsdModule : Module() {
  private var engine: NsdDiscoveryEngine? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.AppContextLost()

  private fun ensureEngine(): NsdDiscoveryEngine {
    if (engine != null) return engine as NsdDiscoveryEngine
    return NsdDiscoveryEngine(context).also { nsd ->
      nsd.setEventHandler { action, service ->
        sendEvent("onService", mapOf("action" to action, "service" to service))
      }
      engine = nsd
    }
  }

  override fun definition() =
      ModuleDefinition {
        Name("ZeroconfNsd")

        Events("onService")

        OnDestroy {
          engine?.close()
          engine = null
        }

        AsyncFunction("watchAll") { types: List<String>, domain: String ->
          ensureEngine().watchAll(types, domain)
        }

        AsyncFunction("unwatchAll") { types: List<String>, domain: String ->
          ensureEngine().unwatchAll(types, domain)
        }

        AsyncFunction("close") {
          engine?.close()
          engine = null
        }
      }
}
