package app.banda

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/** The shell: the web app in Capacitor's web view, with the `Banda` plugin that reaches the daemon over Iroh. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BandaPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
