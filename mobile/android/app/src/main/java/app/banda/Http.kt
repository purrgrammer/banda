package app.banda

import java.io.ByteArrayOutputStream

/**
 * HTTP/1.1 over one Iroh bi-stream, as the daemon serves it: one request a stream, the response ended by the daemon
 * (`connection: close`). Only what the daemon's API needs: a head, then a body that is chunked, has a length, or runs
 * to the stream's end.
 */
internal object Http {
    /** Headers the shell sets itself: the app's would contradict the framing. */
    private val OWN = setOf("host", "connection", "content-length", "transfer-encoding", "authorization")

    fun request(method: String, path: String, headers: Map<String, String>, body: ByteArray?): ByteArray {
        require(path.startsWith("/") && path.none { it == '\r' || it == '\n' || it == ' ' }) { "not a path: $path" }
        require(method.all { it in 'A'..'Z' }) { "not a method: $method" }
        val head = StringBuilder()
        head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
        // the daemon ignores Host over Iroh; HTTP/1.1 needs one
        head.append("host: banda\r\nconnection: close\r\n")
        for ((name, value) in headers) {
            val key = name.lowercase()
            if (key in OWN || !key.all { it.isLetterOrDigit() || it == '-' } || value.any { it == '\r' || it == '\n' }) continue
            head.append(key).append(": ").append(value).append("\r\n")
        }
        if (body != null) head.append("content-length: ").append(body.size).append("\r\n")
        head.append("\r\n")
        val bytes = head.toString().toByteArray(Charsets.UTF_8)
        return if (body == null) bytes else bytes + body
    }

    class Head(val status: Int, val headers: Map<String, String>)

    class Malformed(message: String) : Exception(message)

    /**
     * A response read from `read`, which answers the next bytes the stream has and an empty array at its end. `head()`
     * first, then `body()` until it answers null.
     */
    class Response(private val read: suspend () -> ByteArray) {
        private var buffer = ByteArray(0)
        private var at = 0
        private var ended = false
        private var mode: Mode = Mode.ToEnd
        private var left = 0L
        private var over = false

        private sealed interface Mode {
            data object ToEnd : Mode
            data object Length : Mode
            data object Chunked : Mode
        }

        private suspend fun more(): Boolean {
            if (ended) return false
            val next = read()
            if (next.isEmpty()) {
                ended = true
                return false
            }
            buffer = if (at == buffer.size) next else buffer.copyOfRange(at, buffer.size) + next
            at = 0
            return true
        }

        private suspend fun line(): String {
            val bytes = ByteArrayOutputStream()
            while (true) {
                while (at < buffer.size) {
                    val byte = buffer[at++]
                    if (byte == '\n'.code.toByte()) {
                        val text = bytes.toString(Charsets.ISO_8859_1.name())
                        return text.removeSuffix("\r")
                    }
                    bytes.write(byte.toInt())
                    if (bytes.size() > 64 * 1024) throw Malformed("a line too long")
                }
                if (!more()) throw Malformed("the stream ended inside the head")
            }
        }

        suspend fun head(): Head {
            val status = line().split(' ', limit = 3)
            if (status.size < 2 || !status[0].startsWith("HTTP/1.")) throw Malformed("not an HTTP response")
            val code = status[1].toIntOrNull() ?: throw Malformed("no status")
            val headers = linkedMapOf<String, String>()
            while (true) {
                val header = line()
                if (header.isEmpty()) break
                val colon = header.indexOf(':')
                if (colon <= 0) continue
                val name = header.substring(0, colon).trim().lowercase()
                val value = header.substring(colon + 1).trim()
                headers[name] = headers[name]?.let { "$it, $value" } ?: value
            }
            val length = headers["content-length"]?.toLongOrNull()
            when {
                headers["transfer-encoding"]?.lowercase()?.contains("chunked") == true -> mode = Mode.Chunked
                length != null -> {
                    mode = Mode.Length
                    left = length
                }
                code == 204 || code == 304 -> {
                    mode = Mode.Length
                    left = 0
                }
            }
            // what the shell framed is its own business: the app reads a body, whole
            headers.remove("transfer-encoding")
            return Head(code, headers)
        }

        /** The next of the body's bytes as they come; null once it is over. */
        suspend fun body(): ByteArray? {
            if (over) return null
            when (mode) {
                Mode.ToEnd -> {
                    if (at == buffer.size && !more()) return finish()
                    return take(buffer.size - at)
                }
                Mode.Length -> {
                    if (left == 0L) return finish()
                    if (at == buffer.size && !more()) throw Malformed("the stream ended inside the body")
                    val piece = take(minOf(left, (buffer.size - at).toLong()).toInt())
                    left -= piece.size
                    return piece
                }
                Mode.Chunked -> {
                    if (left == 0L) {
                        val size = line().substringBefore(';').trim().toLongOrNull(16) ?: throw Malformed("no chunk size")
                        if (size == 0L) {
                            // trailers, then the end
                            while (line().isNotEmpty()) Unit
                            return finish()
                        }
                        left = size
                    }
                    if (at == buffer.size && !more()) throw Malformed("the stream ended inside a chunk")
                    val piece = take(minOf(left, (buffer.size - at).toLong()).toInt())
                    left -= piece.size
                    if (left == 0L && line().isNotEmpty()) throw Malformed("a chunk without its end")
                    return piece
                }
            }
        }

        /** The whole body. */
        suspend fun all(): ByteArray {
            val out = ByteArrayOutputStream()
            while (true) out.write(body() ?: break)
            return out.toByteArray()
        }

        private fun take(count: Int): ByteArray {
            val piece = buffer.copyOfRange(at, at + count)
            at += count
            return piece
        }

        private fun finish(): ByteArray? {
            over = true
            return null
        }
    }
}
