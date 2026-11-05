package app.banda

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class SavedPreferenceTest {
    @Test
    fun failedWritesCannotBecomeSuccessfulByReadingPreferencesAgain() {
        var memory: String? = "old"
        var disk: String? = "old"
        var writable = false
        val saved = SavedPreference({ memory }) { next ->
            memory = next // SharedPreferences changes memory before discovering disk failure.
            if (writable) disk = next
            writable
        }
        assertThrows(IOException::class.java) { saved.set("new") }
        assertEquals("old", memory)
        assertEquals("old", saved.value)
        assertEquals("old", disk)
        writable = true
        saved.set("new")
        assertEquals("new", saved.value)
        assertEquals("new", disk)
        writable = false
        assertThrows(IOException::class.java) { saved.set(null) }
        assertEquals("new", memory)
        assertEquals("new", saved.value)
        writable = true
        saved.set(null)
        assertNull(saved.value)
        assertNull(disk)
    }

    @Test
    fun failedFirstUseDoesNotExposeAnIdentityThatOnlyExistsInMemory() {
        var memory: String? = null
        val saved = SavedPreference({ memory }) { next -> memory = next; false }
        repeat(2) {
            assertThrows(IOException::class.java) { saved.set("key-$it") }
            assertNull(saved.value)
        }
    }
    @Test
    fun writingAnotherKeyCannotFlushARejectedPairingFromDirtyMemory() {
        val memory = mutableMapOf<String, String?>("computer" to "old", "key" to "key-one")
        val disk = memory.toMutableMap()
        val lock = Any()
        var writable = false
        fun pref(key: String) = SavedPreference({ memory[key] }, lock) { next ->
            memory[key] = next
            if (writable) { disk.clear(); disk.putAll(memory) }
            writable
        }
        val computer = pref("computer")
        val key = pref("key")
        assertThrows(IOException::class.java) { computer.set("attacker") }
        writable = true
        key.set("key-two")
        assertEquals("old", disk["computer"])
        assertEquals("old", computer.value)
        assertEquals("key-two", disk["key"])
    }

}
