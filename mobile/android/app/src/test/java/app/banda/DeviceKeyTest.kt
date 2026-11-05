package app.banda

import android.content.Context
import java.lang.reflect.Modifier
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceKeyTest {
    @Test
    fun keyLifecycleHoldsOneMonitorAcrossReadGenerateSaveAndForget() {
        // Both the state screen and endpoint binding call load on IO threads. First use must have one winner,
        // and forgetting cannot race a load that would put the old key back afterwards.
        for (name in listOf("load", "forget")) {
            val method = DeviceKey::class.java.getDeclaredMethod(name, Context::class.java)
            assertTrue("$name must hold DeviceKey's monitor", Modifier.isSynchronized(method.modifiers))
        }
    }
}
