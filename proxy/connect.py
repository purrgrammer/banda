"""A private exec pipe to the proxy data port. No caller can select another destination."""

import os
import selectors
import socket
import sys


def main():
    if sys.argv[1:]:
        raise RuntimeError("The proxy connector takes no destination argument")
    with socket.create_connection(("127.0.0.1", 8080), timeout=5) as connection:
        connection.settimeout(None)
        with selectors.DefaultSelector() as ready:
            ready.register(0, selectors.EVENT_READ, "stdin")
            ready.register(connection, selectors.EVENT_READ, "socket")
            while ready.get_map():
                for event, _ in ready.select():
                    if event.data == "stdin":
                        data = os.read(0, 65536)
                        if data:
                            connection.sendall(data)
                        else:
                            ready.unregister(0)
                            try:
                                connection.shutdown(socket.SHUT_WR)
                            except OSError:
                                pass
                    else:
                        data = connection.recv(65536)
                        if not data:
                            return
                        while data:
                            written = os.write(1, data)
                            data = data[written:]


if __name__ == "__main__":
    main()
