package app.banda

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import computer.iroh.SecretKey
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/**
 * This device's Iroh key: what the daemon knows it by once the owner approved it. The 32 bytes are kept in the app's
 * preferences sealed by an AES key that lives in the Android Keystore and never leaves it, so a copy of the app's
 * files (a backup, another phone) carries nothing that opens. A key that no longer unseals is a new device.
 */
internal object DeviceKey {
    private const val ALIAS = "banda.device"
    private const val SEALED = "device.key"
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    /** The key, made on first use. */
    @Synchronized
    fun load(context: Context): ByteArray {
        val key = Prefs.saved(context, SEALED)
        key.value?.let { sealed ->
            unseal(sealed)?.let { return it }
        }
        val bytes = SecretKey.generate().use { it.toBytes() }
        key.set(seal(bytes))
        return bytes
    }

    /** Make the next key a new one: the daemon will know this device as another. */
    @Synchronized
    fun forget(context: Context) {
        Prefs.saved(context, SEALED).set(null)
        keystore().deleteEntry(ALIAS)
    }

    private fun keystore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun wrapping(): javax.crypto.SecretKey {
        (keystore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun seal(bytes: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrapping())
        val iv = cipher.iv
        return Base64.encodeToString(iv + cipher.doFinal(bytes), Base64.NO_WRAP)
    }

    private fun unseal(sealed: String): ByteArray? =
        try {
            val raw = Base64.decode(sealed, Base64.NO_WRAP)
            val entry = keystore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry ?: return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, entry.secretKey, GCMParameterSpec(GCM_TAG_BITS, raw, 0, IV_BYTES))
            cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES).takeIf { it.size == 32 }
        } catch (_: Exception) {
            null
        }
}

/** The shell's own preferences: the sealed key and the daemon's ticket. */
internal object Prefs {
    private val saved = mutableMapOf<String, SavedPreference>()

    // SharedPreferences memory survives Activity recreation, so this last-successful cache must survive it too.
    @Synchronized
    fun saved(context: Context, key: String): SavedPreference = saved.getOrPut(key) {
        val prefs = context.getSharedPreferences("banda", Context.MODE_PRIVATE)
        SavedPreference(
            { prefs.getString(key, null) },
            this,
            { value -> prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.commit() },
        )
    }
}
