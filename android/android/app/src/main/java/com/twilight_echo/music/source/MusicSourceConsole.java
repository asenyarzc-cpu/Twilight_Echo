package com.twilight.echo.music.source;

import com.whl.quickjs.wrapper.QuickJSContext;

final class MusicSourceConsole implements QuickJSContext.Console {
    interface Listener {
        void onLog(String level, String message);
    }

    private final Listener listener;

    MusicSourceConsole(Listener listener) {
        this.listener = listener;
    }

    @Override
    public void log(String message) {
        listener.onLog("log", message);
    }

    @Override
    public void info(String message) {
        listener.onLog("info", message);
    }

    @Override
    public void warn(String message) {
        listener.onLog("warn", message);
    }

    @Override
    public void error(String message) {
        listener.onLog("error", message);
    }
}
