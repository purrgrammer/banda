package app.banda

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** HTTP/1.1 over one bi-stream, as the daemon answers it: in whatever pieces the stream gives. */
class HttpTest {
    /** A stream that gives `bytes` `size` at a time, then its end. */
    private fun pieces(text: String, size: Int): suspend () -> ByteArray {
        val bytes = text.toByteArray()
        var at = 0
        return {
            val end = minOf(bytes.size, at + size)
            bytes.copyOfRange(at, end).also { at = end }
        }
    }

    @Test fun aChunkedBodyReadsWholeWhateverThePieces() = runBlocking {
        val wire = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" +
            "7\r\nevent: \r\n5\r\nready\r\n0\r\n\r\n"
        for (size in listOf(1, 3, 7, 1000)) {
            val response = Http.Response(pieces(wire, size))
            val head = response.head()
            assertEquals(200, head.status)
            assertEquals("text/event-stream", head.headers["content-type"])
            assertNull(head.headers["transfer-encoding"])
            assertEquals("event: ready", String(response.all()))
            assertNull(response.body())
        }
    }

    @Test fun aBodyWithALengthStopsThere() = runBlocking {
        val response = Http.Response(pieces("HTTP/1.1 201 Created\r\ncontent-length: 2\r\n\r\n{}", 4))
        assertEquals(201, response.head().status)
        assertArrayEquals("{}".toByteArray(), response.all())
    }

    @Test fun noLengthRunsToTheStreamsEndAndNoContentHasNone() = runBlocking {
        val open = Http.Response(pieces("HTTP/1.1 200 OK\r\n\r\nall of it", 2))
        open.head()
        assertEquals("all of it", String(open.all()))
        val none = Http.Response(pieces("HTTP/1.1 204 No Content\r\n\r\n", 5))
        assertEquals(204, none.head().status)
        assertEquals(0, none.all().size)
    }

    @Test fun aStreamThatEndsInsideTheHeadIsNotAResponse() = runBlocking {
        val broken = runCatching { Http.Response(pieces("HTTP/1.1 200 OK\r\ncontent-", 4)).head() }
        assertTrue(broken.exceptionOrNull() is Http.Malformed)
    }

    @Test fun theRequestIsFramedByTheShellAndCarriesNoToken() {
        val text = String(
            Http.request(
                "POST",
                "/api/messages?x=1",
                mapOf("Content-Type" to "application/json", "authorization" to "Bearer t", "host" to "evil", "x-a" to "1\r\nx: 2"),
                "{}".toByteArray(),
            ),
        )
        assertEquals(
            "POST /api/messages?x=1 HTTP/1.1\r\nhost: banda\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}",
            text,
        )
    }
}
