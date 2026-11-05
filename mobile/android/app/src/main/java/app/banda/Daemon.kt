package app.banda

import android.content.Context
import android.util.Log
import computer.iroh.BiStream
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointBuilder
import computer.iroh.EndpointTicket
import computer.iroh.SecretKey
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

/**
 * The daemon this phone is a device of, over Iroh. The shell's endpoint is bound once with the device's key, through
 * n0's relays and discovery; it dials the daemon by the ticket its pairing link carried, keeps the connection, and
 * opens one bi-stream a request on it. A connection that closed is dialed again on the next request.
 */
internal class Daemon(private val context: Context) {
    private val lock = Mutex()
    private var endpoint: Endpoint? = null
    private var connection: Connection? = null

    /** The daemon's ticket, kept once the app chose it; null before pairing. */
    val ticket: String?
        get() = Prefs.of(context).getString(TICKET, null)

    private fun keep(ticket: String?) {
        Prefs.of(context).edit().apply { if (ticket == null) remove(TICKET) else putString(TICKET, ticket) }.commit()
    }

    /** The daemon's endpoint id, from its ticket. */
    fun id(): String? =
        ticket?.let { text ->
            runCatching { EndpointTicket.fromString(text).use { it.endpointAddr().use { addr -> addr.id().toString() } } }
                .getOrNull()
        }

    /** This device's endpoint id: its public key, what the daemon lists it by. */
    fun device(): String = SecretKey.fromBytes(DeviceKey.load(context)).use { key -> key.public().toString() }

    /** Use the daemon `ticket` names from now on: it must parse, and the next request dials it. */
    suspend fun use(ticket: String) {
        EndpointTicket.fromString(ticket).close()
        lock.withLock {
            drop("another daemon")
            keep(ticket)
        }
    }

    /** Forget the daemon and this device's key: the next pairing is a new device. */
    suspend fun forget() {
        lock.withLock {
            drop("forgotten")
            endpoint?.let { runCatching { it.shutdown() } }
            endpoint = null
            keep(null)
            DeviceKey.forget(context)
        }
    }

    /**
     * Why the daemon will not serve this device, in its words, when the connection `stream` was opened on was closed
     * with a refusal (a revoked device); null when it was not, and the daemon was only unreachable.
     */
    fun refusal(): String? = connection?.closeReason()?.takeIf { reason -> REFUSALS.any { reason.contains(it) } }

    /** A new bi-stream to the daemon, dialing it first when there is no live connection. */
    suspend fun open(): BiStream {
        val first = connected()
        return try {
            first.openBi()
        } catch (error: Exception) {
            refusal()?.let { throw Refused(it) }
            // the connection went away under us: dial once more
            lock.withLock { if (connection === first) drop("broken") }
            val second = connected()
            try {
                second.openBi()
            } catch (error: Exception) {
                throw refusal()?.let { Refused(it) } ?: Unreachable("lost the connection to your computer")
            }
        }
    }

    private suspend fun connected(): Connection =
        lock.withLock {
            connection?.let { live ->
                val reason = live.closeReason() ?: return@withLock live
                if (REFUSALS.any { reason.contains(it) }) throw Refused(reason)
                drop(reason)
            }
            val ticket = ticket ?: throw Unreachable("this phone is not paired with a computer yet")
            val bound = endpoint ?: bind().also { endpoint = it }
            val addr = EndpointTicket.fromString(ticket).use { it.endpointAddr() }
            val started = System.currentTimeMillis()
            val dialed =
                try {
                    withTimeout(DIAL_MS) { bound.connect(addr, ALPN) }
                } catch (error: Exception) {
                    throw Unreachable("could not reach your computer")
                } finally {
                    addr.close()
                }
            Log.i(TAG, "connected to ${dialed.remoteId().fmtShort()} in ${System.currentTimeMillis() - started} ms")
            connection = dialed
            dialed
        }

    private fun drop(why: String) {
        connection?.let { live -> runCatching { live.close(0, why.toByteArray()) } }
        connection = null
    }

    private suspend fun bind(): Endpoint {
        val builder = EndpointBuilder()
        builder.applyN0()
        builder.secretKey(DeviceKey.load(context))
        return builder.bind().also { Log.i(TAG, "endpoint ${it.id().fmtShort()} bound") }
    }

    /** The daemon could not be reached: nothing was asked. */
    class Unreachable(message: String) : Exception(message)

    /** The daemon closed this device's connection on purpose: it was revoked. */
    class Refused(message: String) : Exception(message)

    companion object {
        private const val TAG = "banda"
        private const val TICKET = "daemon.ticket"
        private const val DIAL_MS = 30_000L

        /** The one protocol the daemon's endpoint speaks: its HTTP API, one request a bi-stream. */
        val ALPN = "banda/0".toByteArray()

        /** The reasons the daemon closes a device's connection with when it will not serve it (`src/server/remote.ts`). */
        private val REFUSALS = listOf("refused", "revoked")
    }
}
