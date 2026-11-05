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
 *
 * A new code's daemon is tried before it is kept: `use` points requests at it in memory, `keep` saves it once it
 * approved this phone, and `revert` goes back to the saved one. A code never replaces the saved daemon on its own.
 */
internal class Daemon(private val context: Context) {
    private val lock = Mutex()
    private var endpoint: Endpoint? = null
    private var connection: Connection? = null

    /** The ticket of a daemon being tried, not saved. */
    @Volatile private var trial: String? = null

    /** The daemon's ticket: the one being tried, else the one saved once it approved this phone; null before pairing. */
    val ticket: String?
        get() = trial ?: Prefs.of(context).getString(TICKET, null)

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

    /** Try the daemon `ticket` names: it must parse, the next request dials it, and the saved one is kept aside. */
    suspend fun use(ticket: String) {
        EndpointTicket.fromString(ticket).close()
        lock.withLock {
            drop("another daemon")
            trial = ticket
        }
    }

    /** Save the daemon being tried: it approved this phone. */
    suspend fun keep() {
        lock.withLock {
            trial?.let { keep(it) }
            trial = null
        }
    }

    /** Stop trying a daemon: requests go to the saved one again. */
    suspend fun revert() {
        lock.withLock {
            if (trial == null) return@withLock
            trial = null
            drop("back to the saved daemon")
        }
    }

    /** Forget the daemon and this device's key: the next pairing is a new device. */
    suspend fun forget() {
        lock.withLock {
            drop("forgotten")
            endpoint?.let { runCatching { it.shutdown() } }
            endpoint = null
            trial = null
            keep(null)
            DeviceKey.forget(context)
        }
    }

    /**
     * A new bi-stream to the daemon, dialing it first when there is no live connection. A connection the daemon closed,
     * whatever its reason (it restarted, let go of an unpaired phone, or revoked this one), is only dialed again: what
     * this device is comes from the daemon's answer to `GET /api/devices/pair`, never from a close reason.
     */
    suspend fun open(): BiStream {
        val first = connected()
        return try {
            first.openBi()
        } catch (error: Exception) {
            // the connection went away under us: dial once more
            lock.withLock { if (connection === first) drop("broken") }
            val second = connected()
            try {
                second.openBi()
            } catch (error: Exception) {
                throw Unreachable("lost the connection to your computer")
            }
        }
    }

    private suspend fun connected(): Connection =
        lock.withLock {
            connection?.let { live ->
                val reason = live.closeReason() ?: return@withLock live
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

    companion object {
        private const val TAG = "banda"
        private const val TICKET = "daemon.ticket"
        private const val DIAL_MS = 30_000L

        /** The one protocol the daemon's endpoint speaks: its HTTP API, one request a bi-stream. */
        val ALPN = "banda/0".toByteArray()
    }
}
