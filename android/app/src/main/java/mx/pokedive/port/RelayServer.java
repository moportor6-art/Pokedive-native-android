package mx.pokedive.port;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Servidor WebSocket del teléfono anfitrión. No tiene lógica de juego: cada conexión de otro teléfono
 * se pasa tal cual a la página (donde corre el servidor de PokéDive) y lo que la página responde vuelve
 * por el mismo socket.
 */
class RelayServer extends WebSocketServer {

    interface Sink {
        void open(String id, String path);
        void binary(String id, byte[] data);
        void text(String id, String data);
        void closed(String id);
    }

    private final Sink sink;
    private final Map<String, WebSocket> byId = new ConcurrentHashMap<>();
    private final AtomicInteger seq = new AtomicInteger();
    private final CountDownLatch started = new CountDownLatch(1);

    RelayServer(int port, Sink sink) {
        super(new InetSocketAddress(port));
        this.sink = sink;
    }

    boolean awaitStarted(long ms) throws InterruptedException { return started.await(ms, TimeUnit.MILLISECONDS); }

    @Override public void onStart() { started.countDown(); }

    @Override
    public void onOpen(WebSocket ws, ClientHandshake hs) {
        String id = "h" + seq.incrementAndGet();
        ws.setAttachment(id);
        byId.put(id, ws);
        sink.open(id, hs.getResourceDescriptor());
    }

    @Override
    public void onMessage(WebSocket ws, String message) {
        String id = ws.getAttachment();
        if (id != null) sink.text(id, message);
    }

    @Override
    public void onMessage(WebSocket ws, ByteBuffer message) {
        String id = ws.getAttachment();
        if (id == null) return;
        byte[] b = new byte[message.remaining()];
        message.get(b);
        sink.binary(id, b);
    }

    @Override
    public void onClose(WebSocket ws, int code, String reason, boolean remote) {
        String id = ws.getAttachment();
        if (id != null && byId.remove(id) != null) sink.closed(id);
    }

    @Override
    public void onError(WebSocket ws, Exception ex) { }

    void sendBinary(String id, byte[] data) {
        WebSocket ws = byId.get(id);
        if (ws != null && ws.isOpen()) {
            try { ws.send(data); } catch (Exception ignored) { }
        }
    }

    void sendText(String id, String data) {
        WebSocket ws = byId.get(id);
        if (ws != null && ws.isOpen()) {
            try { ws.send(data); } catch (Exception ignored) { }
        }
    }

    void closeConn(String id, int code) {
        WebSocket ws = byId.remove(id);
        if (ws != null) {
            try { ws.close(code < 1000 || code > 4999 ? 1000 : code); } catch (Exception ignored) { }
        }
    }
}
