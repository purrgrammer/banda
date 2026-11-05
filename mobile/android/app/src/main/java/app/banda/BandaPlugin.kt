package app.banda

import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import computer.iroh.BiStream
import computer.iroh.IrohAndroid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

/**
 * The app's `Banda` plugin (`web/src/lib/transport.ts`, `BandaPlugin`): the daemon's HTTP API over Iroh, as this
 * paired device. Each request is one HTTP/1.1 request on its own bi-stream; a stream (server-sent events) answers its
 * head, then its body as `chunk` events and one `end`. No token: the device's key, which the QUIC handshake proves, is
 * what the daemon lets in. Two rules from the spike hold on this side too: the request's send side is finished once it
 * is written, and a finished send side is never reset (stopping a stream stops its receive side instead).
 */
@CapacitorPlugin(name = "Banda")
class BandaPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var daemon: Daemon
    private val streams = ConcurrentHashMap<String, Running>()

    /** A `banda://pair` link the app was opened with, until the app pairs with it. */
    @Volatile private var link: String? = null

    private class Running(val job: Job, @Volatile var bi: BiStream? = null)

    override fun load() {
        IrohAndroid.installAndroidContext(context)
        daemon = Daemon(context)
        link = pairingLink(activity?.intent)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        val url = pairingLink(intent) ?: return
        link = url
        notifyListeners("link", JSObject().put("url", url))
    }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    private fun pairingLink(intent: Intent?): String? {
        val data = intent?.data ?: return null
        return if (data.scheme == "banda" && data.host == "pair") data.toString() else null
    }

    /** Where the shell stands: the daemon it is set to, this device's id and a name to suggest, a link opened with. */
    @PluginMethod
    fun state(call: PluginCall) {
        scope.launch {
            try {
                val answer = JSObject()
                daemon.id()?.let { answer.put("daemon", it) }
                answer.put("device", daemon.device())
                answer.put("name", deviceName())
                link?.let { answer.put("link", it) }
                call.resolve(answer)
            } catch (error: Exception) {
                call.reject(error.message ?: "the shell could not read its state", error)
            }
        }
    }

    /** Use the daemon a pairing link's ticket names: requests go to it from now on. */
    @PluginMethod
    fun setDaemon(call: PluginCall) {
        val ticket = call.getString("ticket") ?: return call.reject("a ticket is needed")
        scope.launch {
            try {
                daemon.use(ticket)
                link = null
                call.resolve()
            } catch (error: Exception) {
                call.reject("that code is not a banda pairing code", "TICKET", error)
            }
        }
    }

    /** Forget the daemon and this device's key: a revoked phone pairs again as a new device. */
    @PluginMethod
    fun forget(call: PluginCall) {
        scope.launch {
            for (running in streams.values) running.job.cancel()
            streams.clear()
            daemon.forget()
            call.resolve()
        }
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val method = call.getString("method") ?: "GET"
        val path = call.getString("path") ?: return call.reject("a path is needed")
        val headers = headersOf(call.getObject("headers"))
        val body = call.getString("body")?.let { Base64.decode(it, Base64.NO_WRAP) }
        scope.launch {
            var bi: BiStream? = null
            try {
                bi = send(method, path, headers, body)
                val recv = bi.recv()
                val response = Http.Response { recv.read(CHUNK) }
                val head = response.head()
                val bytes = response.all()
                call.resolve(
                    JSObject()
                        .put("status", head.status)
                        .put("headers", JSObject().apply { head.headers.forEach { (k, v) -> put(k, v) } })
                        .put("body", Base64.encodeToString(bytes, Base64.NO_WRAP)),
                )
            } catch (error: Exception) {
                reject(call, error)
            } finally {
                bi?.close()
            }
        }
    }

    @PluginMethod
    fun stream(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("an id is needed")
        val path = call.getString("path") ?: return call.reject("a path is needed")
        val headers = headersOf(call.getObject("headers"))
        val job =
            scope.launch(start = CoroutineStart.LAZY) {
                var answered = false
                var bi: BiStream? = null
                try {
                    bi = send("GET", path, headers, null)
                    streams[id]?.bi = bi
                    val recv = bi.recv()
                    val response = Http.Response { recv.read(CHUNK) }
                    val head = response.head()
                    call.resolve(
                        JSObject()
                            .put("status", head.status)
                            .put("headers", JSObject().apply { head.headers.forEach { (k, v) -> put(k, v) } }),
                    )
                    answered = true
                    while (true) {
                        val piece = response.body() ?: break
                        if (piece.isEmpty()) continue
                        notifyListeners("chunk", JSObject().put("id", id).put("data", Base64.encodeToString(piece, Base64.NO_WRAP)))
                    }
                    if (streams.remove(id) != null) notifyListeners("end", JSObject().put("id", id))
                } catch (error: CancellationException) {
                    // cancelled by the app: it hears nothing more
                    if (!answered) call.reject("cancelled", "CANCELLED")
                } catch (error: Exception) {
                    if (!answered) {
                        streams.remove(id)
                        reject(call, error)
                    } else if (streams.remove(id) != null) {
                        notifyListeners("end", JSObject().put("id", id).put("error", error.message ?: "the stream broke"))
                    }
                } finally {
                    bi?.let { open ->
                        withContext(NonCancellable) {
                            // the request's send side finished long ago: stop reading, never reset
                            runCatching { open.recv().stop(0u) }
                        }
                        open.close()
                    }
                }
            }
        streams[id] = Running(job)
        job.start()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("an id is needed")
        streams.remove(id)?.job?.cancel()
        call.resolve()
    }

    /** Open a bi-stream, write the request whole and finish its send side: the daemon answers once it has it all. */
    private suspend fun send(method: String, path: String, headers: Map<String, String>, body: ByteArray?): BiStream {
        val bytes = Http.request(method, path, headers, body)
        val bi = daemon.open()
        try {
            val send = bi.send()
            var at = 0
            while (at < bytes.size) {
                val end = minOf(bytes.size, at + CHUNK.toInt())
                send.writeAll(bytes.copyOfRange(at, end))
                at = end
            }
            send.finish()
        } catch (error: Exception) {
            bi.close()
            throw error
        }
        Log.d(TAG, "$method ${path.substringBefore('?')}")
        return bi
    }

    /**
     * Unreachable or broken: the app tells them apart by the code. Neither says what this device is; the daemon's
     * answer to `GET /api/devices/pair` does.
     */
    private fun reject(call: PluginCall, error: Exception) {
        if (error is Daemon.Unreachable) call.reject(error.message, "UNREACHABLE", error)
        else call.reject(error.message ?: "the request broke", "BROKEN", error)
    }

    private fun headersOf(headers: JSObject?): Map<String, String> {
        if (headers == null) return emptyMap()
        val map = linkedMapOf<String, String>()
        for (name in headers.keys()) headers.getString(name)?.let { map[name] = it }
        return map
    }

    private fun deviceName(): String =
        Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: Build.MODEL

    companion object {
        private const val TAG = "banda"

        /** At most this much is read from a stream at once. */
        private val CHUNK = 64u * 1024u
    }
}
