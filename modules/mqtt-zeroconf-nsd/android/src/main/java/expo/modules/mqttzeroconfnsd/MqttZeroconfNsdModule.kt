package expo.modules.mqttzeroconfnsd

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MqttZeroconfNsdModule : Module() {
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
        Name("MqttZeroconfNsd")

        Events("onService")

        OnDestroy {
          engine?.close()
          engine = null
        }

        AsyncFunction("watch") { type: String, domain: String ->
          ensureEngine().watch(type, domain)
        }

        AsyncFunction("unwatch") { type: String, domain: String ->
          ensureEngine().unwatch(type, domain)
        }

        AsyncFunction("close") {
          engine?.close()
          engine = null
        }
      }
}
