package app.banda

import java.io.IOException

/**
 * The last value whose disk write succeeded. SharedPreferences changes its memory even when commit returns false;
 * restore that memory before another key's write can flush the whole preferences map to disk.
 */
internal class SavedPreference(
    read: () -> String?,
    private val lock: Any = Any(),
    private val write: (String?) -> Boolean,
) {
    @Volatile var value: String? = read()
        private set

    fun set(next: String?) = synchronized(lock) {
        try {
            if (!write(next)) throw IOException("could not save the pairing; check the phone’s storage and try again")
        } catch (error: Exception) {
            // Even a failed commit updates memory. All keys share this lock, including rollback, so a later
            // successful commit cannot accidentally persist a value whose caller was told it failed.
            try {
                write(value)
            } catch (restore: Exception) {
                error.addSuppressed(restore)
            }
            throw error
        }
        value = next
    }
}
