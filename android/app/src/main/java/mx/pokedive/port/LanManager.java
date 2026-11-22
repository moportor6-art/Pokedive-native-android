package mx.pokedive.port;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Salas por wifi.
 *  - Anfitrión: la página avisa de su sala (lanHost); se arranca el RelayServer y se anuncia por UDP.
 *    Lo que llega al relay se pasa a la página (window.__pdLanHost) y lo que contesta vuelve al socket.
 *  - Invitado: escucha los anuncios (lanRooms) y abre conexiones nativas hacia el anfitrión
 *    (la página es https y no puede abrir ws:// directamente); los mensajes llegan a window.__pdLanClient.
 * Los datos binarios cruzan el puente en base64.
 */
class LanManager implements RelayServer.Sink {
    private static final String TAG = "PdLan";
    static final int DISCOVERY_PORT = 47812;
    static final int RELAY_PORT = 8797;
    private static final String MAGIC = "PDROOM1";

    private final Context ctx;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final String instanceId = UUID.randomUUID().toString().substring(0, 8);

    private final Map<String, JSONObject> found = new ConcurrentHashMap<>();
    private final Map<String, Long> seen = new ConcurrentHashMap<>();
    private final Map<String, Conn> conns = new ConcurrentHashMap<>();
    private final AtomicInteger seq = new AtomicInteger();

    private volatile RelayServer server;
    private volatile int serverPort = -1;
    private volatile String hosted = "";
    private volatile boolean running = true;
    private DatagramSocket udp;
    private WifiManager.MulticastLock mlock;

    LanManager(Context ctx, WebView web) {
        this.ctx = ctx.getApplicationContext();
        this.web = web;
        try {
            WifiManager wm = (WifiManager) this.ctx.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                mlock = wm.createMulticastLock("pokedive-lan");
                mlock.setReferenceCounted(false);
                mlock.acquire();
            }
        } catch (Exception e) { Log.w(TAG, "multicast lock", e); }
        pool.execute(this::listenLoop);
        pool.execute(this::beaconLoop);
    }

    // ---------------------------------------------------------------- descubrimiento

    private void listenLoop() {
        try {
            udp = new DatagramSocket(null);
            udp.setReuseAddress(true);
            udp.setBroadcast(true);
            udp.bind(new java.net.InetSocketAddress(DISCOVERY_PORT));
            byte[] buf = new byte[2048];
            while (running) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                udp.receive(p);
                String s = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                int a = s.indexOf('|'), b = a < 0 ? -1 : s.indexOf('|', a + 1), c = b < 0 ? -1 : s.indexOf('|', b + 1);
                if (c < 0 || !MAGIC.equals(s.substring(0, a))) continue;
                String inst = s.substring(a + 1, b);
                if (instanceId.equals(inst)) continue;
                int port = parseInt(s.substring(b + 1, c), RELAY_PORT);
                try {
                    JSONObject o = new JSONObject(s.substring(c + 1));
                    o.put("ip", p.getAddress().getHostAddress());
                    o.put("port", port);
                    String key = o.optString("roomId");
                    if (key.isEmpty()) continue;
                    found.put(key, o);
                    seen.put(key, System.currentTimeMillis());
                } catch (Exception ignored) { }
            }
        } catch (Exception e) {
            if (running) Log.w(TAG, "listen", e);
        }
    }

    private void beaconLoop() {
        while (running) {
            try {
                Thread.sleep(1000);
                String info = hosted;
                if (info.isEmpty() || serverPort < 0) continue;
                byte[] msg = (MAGIC + "|" + instanceId + "|" + serverPort + "|" + info).getBytes(StandardCharsets.UTF_8);
                try (DatagramSocket out = new DatagramSocket()) {
                    out.setBroadcast(true);
                    for (InetAddress a : broadcastTargets()) {
                        try { out.send(new DatagramPacket(msg, msg.length, a, DISCOVERY_PORT)); } catch (Exception ignored) { }
                    }
                }
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                Log.w(TAG, "beacon", e);
            }
        }
    }

    private static List<InetAddress> broadcastTargets() {
        List<InetAddress> out = new ArrayList<>();
        try { out.add(InetAddress.getByName("255.255.255.255")); } catch (Exception ignored) { }
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress b = ia.getBroadcast();
                    if (b != null && !out.contains(b)) out.add(b);
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    private static List<String> localIps() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    InetAddress a = ia.getAddress();
                    if (a instanceof java.net.Inet4Address) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    String roomsJson() {
        JSONArray a = new JSONArray();
        long now = System.currentTimeMillis();
        for (Map.Entry<String, JSONObject> e : found.entrySet()) {
            Long t = seen.get(e.getKey());
            if (t == null || now - t > 5000) continue;
            a.put(e.getValue());
        }
        return a.toString();
    }

    String infoJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("ips", new JSONArray(localIps()));
            o.put("port", serverPort);
            o.put("hosting", !hosted.isEmpty());
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    // ---------------------------------------------------------------- anfitrión

    /** La página publica (o retira, con "") la sala que se puede ver en la wifi. */
    void host(String json) {
        hosted = json == null ? "" : json;
        if (!hosted.isEmpty()) pool.execute(this::ensureServer);
    }

    private synchronized int ensureServer() {
        if (server != null) return serverPort;
        for (int port = RELAY_PORT; port < RELAY_PORT + 10; port++) {
            try {
                RelayServer s = new RelayServer(port, this);
                s.setReuseAddr(true);
                s.setTcpNoDelay(true);
                s.setConnectionLostTimeout(20);
                s.start();
                if (s.awaitStarted(3000)) {
                    server = s;
                    serverPort = port;
                    Log.i(TAG, "relay en puerto " + port);
                    return port;
                }
                try { s.stop(200); } catch (Exception ignored) { }
            } catch (Exception e) {
                Log.w(TAG, "puerto " + port, e);
            }
        }
        return -1;
    }

    @Override public void open(String id, String path) { emit("__pdLanHost", "open", id, path); }
    @Override public void binary(String id, byte[] data) { emit("__pdLanHost", "msg", id, Base64.encodeToString(data, Base64.NO_WRAP)); }
    @Override public void text(String id, String data) { emit("__pdLanHost", "text", id, data); }
    @Override public void closed(String id) { emit("__pdLanHost", "close", id, null); }

    void hostSend(String id, String b64) {
        RelayServer s = server;
        if (s != null) s.sendBinary(id, Base64.decode(b64, Base64.NO_WRAP));
    }

    void hostText(String id, String text) {
        RelayServer s = server;
        if (s != null) s.sendText(id, text);
    }

    void hostClose(String id, int code) {
        RelayServer s = server;
        if (s == null) return;
        if (code < 1000 || code > 4999 || (code >= 1004 && code <= 1006) || code == 1015) code = 1000;
        s.closeConn(id, code);
    }

    // ---------------------------------------------------------------- invitado

    class Conn extends WebSocketClient {
        final String id;
        volatile boolean closedByJs;
        Conn(String id, URI uri) { super(uri); this.id = id; setConnectionLostTimeout(20); setTcpNoDelay(true); }
        @Override public void onOpen(ServerHandshake h) { emit("__pdLanClient", "open", id, null); }
        @Override public void onMessage(String m) { emit("__pdLanClient", "text", id, m); }
        @Override public void onMessage(ByteBuffer b) {
            byte[] a = new byte[b.remaining()];
            b.get(a);
            emit("__pdLanClient", "msg", id, Base64.encodeToString(a, Base64.NO_WRAP));
        }
        @Override public void onClose(int code, String reason, boolean remote) {
            conns.remove(id);
            if (!closedByJs) emit("__pdLanClient", "close", id, String.valueOf(code));
        }
        @Override public void onError(Exception e) { }
    }

    String connect(final String url) {
        final String id = "c" + seq.incrementAndGet();
        pool.execute(() -> {
            try {
                Conn c = new Conn(id, new URI(url));
                conns.put(id, c);
                if (!c.connectBlocking(6, java.util.concurrent.TimeUnit.SECONDS)) {
                    conns.remove(id);
                    emit("__pdLanClient", "error", id, "timeout");
                }
            } catch (Exception e) {
                Log.w(TAG, "connect", e);
                conns.remove(id);
                emit("__pdLanClient", "error", id, String.valueOf(e.getMessage()));
            }
        });
        return id;
    }

    void send(String id, String b64) {
        Conn c = conns.get(id);
        if (c != null && c.isOpen()) {
            try { c.send(Base64.decode(b64, Base64.NO_WRAP)); } catch (Exception ignored) { }
        }
    }

    void text(String id, String text) {
        Conn c = conns.get(id);
        if (c != null && c.isOpen()) {
            try { c.send(text); } catch (Exception ignored) { }
        }
    }

    void close(String id) {
        Conn c = conns.remove(id);
        if (c != null) {
            c.closedByJs = true;
            pool.execute(() -> { try { c.close(); } catch (Exception ignored) { } });
        }
    }

    private void emit(String fn, String kind, String id, String data) {
        final String js = "window." + fn + "&&window." + fn + "(" + JSONObject.quote(kind) + "," + JSONObject.quote(id) + ","
                + (data == null ? "null" : JSONObject.quote(data)) + ")";
        ui.post(() -> { try { web.evaluateJavascript(js, null); } catch (Exception ignored) { } });
    }

    void shutdown() {
        running = false;
        hosted = "";
        for (Conn c : conns.values()) { c.closedByJs = true; try { c.close(); } catch (Exception ignored) { } }
        conns.clear();
        try { if (udp != null) udp.close(); } catch (Exception ignored) { }
        try { if (server != null) server.stop(300); } catch (Exception ignored) { }
        try { if (mlock != null && mlock.isHeld()) mlock.release(); } catch (Exception ignored) { }
        pool.shutdownNow();
    }

    private static int parseInt(String s, int d) {
        try { return Integer.parseInt(s.trim()); } catch (Exception e) { return d; }
    }
}
