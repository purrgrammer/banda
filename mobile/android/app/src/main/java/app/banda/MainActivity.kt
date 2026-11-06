package app.banda

import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity

/** The shell: the web app in Capacitor's web view, with the `Banda` plugin that reaches the daemon over Iroh. */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BandaPlugin::class.java)
        super.onCreate(savedInstanceState)
        // Keep the whole web viewport, including fixed dialogs, inside the usable window.
        // Own insets here instead of SystemBars' CSS handling so keyboard and cutout
        // changes resize every screen without each web component adding its own padding.
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
    }
}
