package com.twilight.echo.music.source;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;

import androidx.annotation.NonNull;

import com.whl.quickjs.android.QuickJSLoader;
import com.whl.quickjs.wrapper.QuickJSContext;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import io.flutter.plugin.common.BinaryMessenger;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;

public final class MusicSourceRuntimeBridge implements MethodChannel.MethodCallHandler {
    private static final String CHANNEL = "twilight_echo/music_source_runtime";
    private static final int MAX_SCRIPT_LENGTH = 2 * 1024 * 1024;

    private final Context context;
    private final MethodChannel channel;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, MethodChannel.Result> pendingResolves =
        new ConcurrentHashMap<>();
    private final Map<Integer, Runnable> timers = new ConcurrentHashMap<>();

    private HandlerThread scriptThread;
    private Handler scriptHandler;
    private QuickJSContext jsContext;
    private MethodChannel.Result pendingLoad;

    public MusicSourceRuntimeBridge(Context context, BinaryMessenger messenger) {
        this.context = context.getApplicationContext();
        this.channel = new MethodChannel(messenger, CHANNEL);
        this.channel.setMethodCallHandler(this);
    }

    @Override
    public void onMethodCall(@NonNull MethodCall call, @NonNull MethodChannel.Result result) {
        switch (call.method) {
            case "load":
                load(asMap(call.arguments), result);
                break;
            case "resolve":
                resolve(asMap(call.arguments), result);
                break;
            case "httpResponse":
                postToScript("httpResponse", new JSONObject(asMap(call.arguments)).toString());
                result.success(null);
                break;
            case "dispose":
                disposeRuntime("音源运行时已关闭");
                result.success(null);
                break;
            default:
                result.notImplemented();
        }
    }

    public void close() {
        channel.setMethodCallHandler(null);
        disposeRuntime("音源运行时已关闭");
    }

    private void load(Map<String, Object> arguments, MethodChannel.Result result) {
        String script = stringValue(arguments.get("script"));
        if (script.isEmpty() || script.length() > MAX_SCRIPT_LENGTH) {
            result.error("INVALID_SCRIPT", "音源脚本为空或超过 2 MB", null);
            return;
        }
        disposeRuntime("音源已切换");
        pendingLoad = result;
        scriptThread = new HandlerThread("MusicSourceQuickJS");
        scriptThread.start();
        scriptHandler = new Handler(scriptThread.getLooper());
        scriptHandler.post(() -> createRuntime(arguments, script));
    }

    private void createRuntime(Map<String, Object> arguments, String script) {
        try {
            QuickJSLoader.init();
            jsContext = QuickJSContext.create();
            jsContext.setConsole(new MusicSourceConsole(this::sendLog));
            installNativeFunctions(jsContext);
            jsContext.evaluate(readAsset("music_source_preload.js"));
            JSONObject metadata = new JSONObject();
            for (String key : new String[]{
                "id", "name", "description", "author", "homepage", "version"
            }) {
                metadata.put(key, stringValue(arguments.get(key)));
            }
            metadata.put("rawScript", script);
            jsContext.getGlobalObject()
                .getJSFunction("music_source_setup")
                .call(metadata.toString());
            jsContext.evaluate(script);
        } catch (Throwable error) {
            failLoad(messageOf(error));
        }
    }

    private void resolve(Map<String, Object> arguments, MethodChannel.Result result) {
        Handler handler = scriptHandler;
        if (handler == null || jsContext == null) {
            result.error("NO_SOURCE", "请先导入并启用音源", null);
            return;
        }
        String requestId = UUID.randomUUID().toString();
        pendingResolves.put(requestId, result);
        JSONObject payload = new JSONObject(arguments);
        try {
            payload.put("requestId", requestId);
        } catch (Exception error) {
            pendingResolves.remove(requestId);
            result.error("INVALID_REQUEST", messageOf(error), null);
            return;
        }
        handler.post(() -> callJs("resolve", payload.toString()));
    }

    private void installNativeFunctions(QuickJSContext context) {
        context.getGlobalObject().setProperty("__music_source_native_call__", args -> {
            handleScriptAction(stringValue(args[0]), stringValue(args[1]));
            return null;
        });
        context.getGlobalObject().setProperty("__music_source_md5__", args ->
            safeNative(() -> MusicSourceCrypto.md5(stringValue(args[0])))
        );
        context.getGlobalObject().setProperty("__music_source_bytes_to_b64__", args ->
            safeNative(() -> MusicSourceCrypto.bytesToBase64(stringValue(args[0])))
        );
        context.getGlobalObject().setProperty("__music_source_b64_to_bytes__", args ->
            safeNative(() -> MusicSourceCrypto.base64ToBytes(stringValue(args[0])))
        );
        context.getGlobalObject().setProperty("__music_source_aes_encrypt__", args ->
            safeNative(() -> MusicSourceCrypto.aesEncrypt(
                stringValue(args[0]),
                stringValue(args[1]),
                stringValue(args[2]),
                stringValue(args[3])
            ))
        );
        context.getGlobalObject().setProperty("__music_source_rsa_encrypt__", args ->
            safeNative(() -> MusicSourceCrypto.rsaEncrypt(
                stringValue(args[0]),
                stringValue(args[1]),
                stringValue(args[2])
            ))
        );
        context.getGlobalObject().setProperty("__music_source_set_timeout__", args -> {
            int id = ((Number) args[0]).intValue();
            long delay = Math.max(0, Math.min(((Number) args[1]).longValue(), 60_000));
            Runnable timer = () -> {
                timers.remove(id);
                postToScript("timeout", String.valueOf(id));
            };
            timers.put(id, timer);
            mainHandler.postDelayed(timer, delay);
            return null;
        });
        context.getGlobalObject().setProperty("__music_source_clear_timeout__", args -> {
            int id = ((Number) args[0]).intValue();
            Runnable timer = timers.remove(id);
            if (timer != null) mainHandler.removeCallbacks(timer);
            return null;
        });
    }

    private void handleScriptAction(String action, String data) {
        try {
            JSONObject payload = data.isEmpty() ? new JSONObject() : new JSONObject(data);
            switch (action) {
                case "init":
                    if (!payload.optBoolean("status")) {
                        failLoad(payload.optString("error", "音源初始化失败"));
                    } else {
                        completeLoad(jsonValue(payload.optJSONObject("info")));
                    }
                    break;
                case "resolveResult":
                    completeResolve(payload);
                    break;
                case "httpRequest":
                    sendEvent("httpRequest", payload);
                    break;
                case "httpCancel":
                    sendEvent("httpCancel", payload);
                    break;
                case "log":
                    sendEvent("log", payload);
                    break;
                default:
                    sendLog("warn", "Unknown source action: " + action);
            }
        } catch (Throwable error) {
            sendLog("error", messageOf(error));
        }
    }

    private void completeResolve(JSONObject payload) {
        String requestId = payload.optString("requestId");
        MethodChannel.Result result = pendingResolves.remove(requestId);
        if (result == null) return;
        if (!payload.optBoolean("status")) {
            postError(result, "RESOLVE_FAILED", payload.optString("error", "音源解析失败"));
            return;
        }
        Map<String, Object> response = new HashMap<>();
        response.put("url", payload.optString("url"));
        if (payload.has("fileName") && !payload.isNull("fileName")) {
            String fileName = payload.optString("fileName", "").trim();
            if (!fileName.isEmpty()
                && !fileName.equalsIgnoreCase("null")
                && !fileName.equalsIgnoreCase("undefined")) {
                response.put("fileName", fileName);
            }
        }
        postSuccess(result, response);
    }

    private void completeLoad(Object info) {
        MethodChannel.Result result = pendingLoad;
        pendingLoad = null;
        if (result != null) postSuccess(result, info);
    }

    private void failLoad(String message) {
        MethodChannel.Result result = pendingLoad;
        pendingLoad = null;
        if (result != null) postError(result, "LOAD_FAILED", message);
    }

    private void callJs(String action, String data) {
        try {
            if (jsContext == null) return;
            jsContext.getGlobalObject()
                .getJSFunction("__music_source_handle__")
                .call(action, data);
        } catch (Throwable error) {
            sendLog("error", messageOf(error));
        }
    }

    private void postToScript(String action, String data) {
        Handler handler = scriptHandler;
        if (handler != null) handler.post(() -> callJs(action, data));
    }

    private void disposeRuntime(String reason) {
        failLoad(reason);
        for (Map.Entry<String, MethodChannel.Result> entry : pendingResolves.entrySet()) {
            postError(entry.getValue(), "RUNTIME_DISPOSED", reason);
        }
        pendingResolves.clear();
        for (Runnable timer : timers.values()) mainHandler.removeCallbacks(timer);
        timers.clear();
        Handler handler = scriptHandler;
        QuickJSContext contextToDestroy = jsContext;
        jsContext = null;
        scriptHandler = null;
        if (handler != null && contextToDestroy != null) {
            handler.post(() -> {
                try {
                    contextToDestroy.destroy();
                } catch (Throwable ignored) {}
            });
        }
        HandlerThread thread = scriptThread;
        scriptThread = null;
        if (thread != null) thread.quitSafely();
    }

    private String readAsset(String name) throws Exception {
        try (InputStream input = context.getAssets().open(name)) {
            byte[] bytes = new byte[input.available()];
            int count = input.read(bytes);
            if (count <= 0) throw new IllegalStateException("预加载脚本为空");
            return new String(bytes, 0, count, StandardCharsets.UTF_8);
        }
    }

    private void sendLog(String level, String message) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("level", level);
            payload.put("message", message.length() > 2000 ? message.substring(0, 2000) : message);
        } catch (Exception ignored) {}
        sendEvent("log", payload);
    }

    private void sendEvent(String type, JSONObject payload) {
        Object converted = jsonValue(payload);
        if (!(converted instanceof Map)) return;
        @SuppressWarnings("unchecked")
        Map<String, Object> event = new HashMap<>((Map<String, Object>) converted);
        event.put("type", type);
        mainHandler.post(() -> channel.invokeMethod("event", event));
    }

    private void postSuccess(MethodChannel.Result result, Object value) {
        mainHandler.post(() -> result.success(value));
    }

    private void postError(MethodChannel.Result result, String code, String message) {
        mainHandler.post(() -> result.error(code, message, null));
    }

    private Object jsonValue(Object raw) {
        if (raw == null || raw == JSONObject.NULL) return null;
        if (raw instanceof JSONObject) {
            JSONObject object = (JSONObject) raw;
            Map<String, Object> result = new HashMap<>();
            for (java.util.Iterator<String> it = object.keys(); it.hasNext();) {
                String key = it.next();
                result.put(key, jsonValue(object.opt(key)));
            }
            return result;
        }
        if (raw instanceof JSONArray) {
            JSONArray array = (JSONArray) raw;
            List<Object> result = new ArrayList<>();
            for (int index = 0; index < array.length(); index++) {
                result.add(jsonValue(array.opt(index)));
            }
            return result;
        }
        return raw;
    }

    private static Map<String, Object> asMap(Object raw) {
        Map<String, Object> result = new HashMap<>();
        if (raw instanceof Map) {
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) raw).entrySet()) {
                result.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        }
        return result;
    }

    private static String stringValue(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static String messageOf(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private interface NativeOperation {
        String run() throws Exception;
    }

    private static String safeNative(NativeOperation operation) {
        try {
            return operation.run();
        } catch (Exception error) {
            return "";
        }
    }
}
