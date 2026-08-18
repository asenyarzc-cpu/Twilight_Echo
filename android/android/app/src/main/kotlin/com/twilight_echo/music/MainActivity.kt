package com.twilight.echo

import android.content.Intent
import android.graphics.Color
import android.hardware.display.DisplayManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.storage.StorageManager
import android.os.storage.StorageVolume
import android.view.Display
import android.view.Surface
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import com.twilight.echo.music.source.MusicSourceRuntimeBridge
import com.ryanheise.audioservice.AudioServiceActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.lang.reflect.Array
import java.util.Locale
import kotlin.math.abs
import org.jaudiotagger.audio.AudioFileIO
import org.jaudiotagger.tag.FieldKey
import org.jaudiotagger.tag.Tag
import org.jaudiotagger.tag.images.AndroidArtwork
import org.jaudiotagger.tag.reference.PictureTypes

class MainActivity : AudioServiceActivity() {
    private val mediaScanChannel = "twilight_echo/media_scan"
    private val audioIntentChannel = "twilight_echo/audio_intent"
    private val nativeTaggerChannel = "twilight_echo/native_tagger"
    private val appTaskChannel = "twilight_echo/app_task"
    private val storageBrowserChannel = "twilight_echo/storage_browser"
    private var musicSourceRuntimeBridge: MusicSourceRuntimeBridge? = null
    private var displayListener: DisplayManager.DisplayListener? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyEdgeToEdgeSystemBars()
        applyHighestRefreshRate()
        registerDisplayListener()
    }

    override fun onResume() {
        super.onResume()
        applyEdgeToEdgeSystemBars()
        applyHighestRefreshRate()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            applyEdgeToEdgeSystemBars()
            applyHighestRefreshRate()
        }
    }

    override fun onDestroy() {
        unregisterDisplayListener()
        musicSourceRuntimeBridge?.close()
        musicSourceRuntimeBridge = null
        super.onDestroy()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        musicSourceRuntimeBridge?.close()
        musicSourceRuntimeBridge =
            MusicSourceRuntimeBridge(applicationContext, flutterEngine.dartExecutor.binaryMessenger)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, mediaScanChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "scan" -> {
                        val path = call.argument<String>("path")
                        if (path.isNullOrEmpty()) {
                            result.error("INVALID_ARGS", "path is required", null)
                            return@setMethodCallHandler
                        }
                        try {
                            MediaScannerConnection.scanFile(
                                applicationContext,
                                arrayOf(path),
                                null,
                                null,
                            )
                            // Best-effort: also broadcast for legacy media stores.
                            sendBroadcast(
                                Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE).apply {
                                    data = Uri.fromFile(java.io.File(path))
                                },
                            )
                            result.success(true)
                        } catch (e: Throwable) {
                            result.error("SCAN_FAILED", e.message, null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, storageBrowserChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "listRoots" -> {
                        try {
                            result.success(
                                listStorageRoots().map {
                                    storageEntry(
                                        file = it.file,
                                        isRoot = true,
                                        label = it.label,
                                        removable = it.removable,
                                        state = it.state,
                                    )
                                },
                            )
                        } catch (e: Throwable) {
                            result.error("LIST_ROOTS_FAILED", e.message, e.toString())
                        }
                    }
                    "listChildren" -> {
                        val path = call.argument<String>("path")
                        if (path.isNullOrEmpty()) {
                            result.error("INVALID_ARGS", "path is required", null)
                            return@setMethodCallHandler
                        }
                        try {
                            result.success(
                                listDirectoryChildren(path).map {
                                    storageEntry(file = it, isRoot = false)
                                },
                            )
                        } catch (e: Throwable) {
                            result.error("LIST_CHILDREN_FAILED", e.message, e.toString())
                        }
                    }
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, audioIntentChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "openAudio" -> {
                        val path = call.argument<String>("path")
                        if (path.isNullOrEmpty()) {
                            result.error("INVALID_ARGS", "path is required", null)
                            return@setMethodCallHandler
                        }
                        try {
                            val file = java.io.File(path)
                            if (!file.exists()) {
                                result.error("NOT_FOUND", "file does not exist", null)
                                return@setMethodCallHandler
                            }
                            val uri = FileProvider.getUriForFile(
                                this,
                                "$packageName.fileprovider",
                                file,
                            )
                            val intent = Intent(Intent.ACTION_VIEW).apply {
                                setDataAndType(uri, "audio/*")
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            startActivity(Intent.createChooser(intent, "播放音乐"))
                            result.success(true)
                        } catch (e: Throwable) {
                            result.error("OPEN_FAILED", e.message, null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, nativeTaggerChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "read" -> readAudioTags(call.arguments as? Map<*, *>, result)
                    "write" -> writeAudioTags(call.arguments as? Map<*, *>, result)
                    else -> result.notImplemented()
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, appTaskChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "moveToBack" -> result.success(moveTaskToBack(true))
                    else -> result.notImplemented()
                }
            }
    }

    private fun readAudioTags(arguments: Map<*, *>?, result: MethodChannel.Result) {
        val path = arguments?.get("path") as? String
        val includeLyrics = arguments?.get("includeLyrics") as? Boolean ?: true
        val includeArtwork = arguments?.get("includeArtwork") as? Boolean ?: true
        if (path.isNullOrEmpty()) {
            result.error("INVALID_ARGS", "path is required", null)
            return
        }

        Thread {
            try {
                val file = java.io.File(path)
                if (!file.exists()) {
                    result.error("NOT_FOUND", "file does not exist", null)
                    return@Thread
                }

                val tag = AudioFileIO.read(file).tag
                val payload = mapOf(
                    "title" to tag?.getFirst(FieldKey.TITLE),
                    "artist" to tag?.getFirst(FieldKey.ARTIST),
                    "album" to tag?.getFirst(FieldKey.ALBUM),
                    "lyrics" to if (includeLyrics) tag?.getFirst(FieldKey.LYRICS) else null,
                    "artwork" to if (includeArtwork) {
                        runCatching { tag?.firstArtwork?.binaryData }.getOrNull()
                    } else {
                        null
                    },
                )
                // MethodChannel.Result is thread-safe. Reply here so encoding a
                // large artwork ByteArray never runs on Android's main thread.
                result.success(payload)
            } catch (e: Throwable) {
                result.error("NATIVE_TAGGER_READ_FAILED", e.message, e.toString())
            }
        }.start()
    }

    private fun writeAudioTags(arguments: Map<*, *>?, result: MethodChannel.Result) {
        val path = arguments?.get("path") as? String
        if (path.isNullOrEmpty()) {
            result.error("INVALID_ARGS", "path is required", null)
            return
        }

        Thread {
            try {
                val file = java.io.File(path)
                if (!file.exists()) {
                    runOnUiThread {
                        result.error("NOT_FOUND", "file does not exist", null)
                    }
                    return@Thread
                }

                val audioFile = AudioFileIO.read(file)
                val tag = audioFile.tagOrCreateDefault
                setTextField(tag, FieldKey.TITLE, arguments["title"] as? String)
                setTextField(tag, FieldKey.ARTIST, arguments["artist"] as? String)
                setTextField(tag, FieldKey.ALBUM, arguments["album"] as? String)
                setTextField(tag, FieldKey.LYRICS, arguments["lyrics"] as? String)

                val artwork = arguments["artwork"] as? ByteArray
                if (artwork != null && artwork.isNotEmpty()) {
                    val artworkMimeType =
                        (arguments["artworkMimeType"] as? String)
                            ?.takeIf { it.startsWith("image/") }
                            ?: "image/jpeg"
                    val image = AndroidArtwork().apply {
                        binaryData = artwork
                        mimeType = artworkMimeType
                        pictureType = PictureTypes.DEFAULT_ID
                    }
                    runCatching { tag.deleteArtworkField() }
                    tag.setField(image)
                }

                audioFile.tag = tag
                AudioFileIO.write(audioFile)

                val written = AudioFileIO.read(file).tagOrCreateDefault
                val lyricsLength = written.getFirst(FieldKey.LYRICS).length
                val artworkLength = runCatching {
                    written.firstArtwork?.binaryData?.size ?: 0
                }.getOrDefault(0)

                runOnUiThread {
                    result.success(
                        mapOf(
                            "lyricsLength" to lyricsLength,
                            "artworkLength" to artworkLength,
                        ),
                    )
                }
            } catch (e: Throwable) {
                runOnUiThread {
                    result.error("NATIVE_TAGGER_FAILED", e.message, e.toString())
                }
            }
        }.start()
    }

    private fun setTextField(tag: Tag, key: FieldKey, value: String?) {
        if (value.isNullOrEmpty()) return
        runCatching { tag.deleteField(key) }
        tag.setField(key, value)
    }

    private data class StorageRoot(
        val file: File,
        val label: String?,
        val removable: Boolean?,
        val state: String?,
    )

    private fun listStorageRoots(): List<StorageRoot> {
        val roots = linkedMapOf<String, StorageRoot>()

        fun addRoot(file: File?, label: String? = null, removable: Boolean? = null, state: String? = null) {
            if (file == null) return
            val normalized = normalizedFile(file)
            if (!normalized.exists() || !normalized.isDirectory) return
            val path = normalized.path
            if (path == "/storage/emulated") return
            roots[path] = StorageRoot(normalized, label, removable, state)
        }

        val primary = Environment.getExternalStorageDirectory()
        addRoot(primary, "内部存储", false, Environment.getExternalStorageState())
        addStorageManagerRoots { file, label, removable, state ->
            addRoot(file, label, removable, state)
        }
        addExternalFilesRoots { file, label, removable, state ->
            addRoot(file, label, removable, state)
        }
        addMountedDirectoryChildren { file, label, removable, state ->
            addRoot(file, label, removable, state)
        }

        val primaryPath = normalizedFile(primary).path
        return roots.values.sortedWith(
            compareBy<StorageRoot> {
                when {
                    it.file.path == primaryPath -> 0
                    it.removable == true -> 1
                    else -> 2
                }
            }.thenBy { (it.label ?: it.file.name).lowercase(Locale.ROOT) },
        )
    }

    private fun addStorageManagerRoots(
        addRoot: (File?, String?, Boolean?, String?) -> Unit,
    ) {
        val storageManager = getSystemService(STORAGE_SERVICE) as? StorageManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            for (volume in storageManager.storageVolumes) {
                val directory = storageVolumeDirectory(volume)
                val label = storageVolumeLabel(volume, directory)
                addRoot(directory, label, volume.isRemovable, volume.state)
            }
            return
        }

        runCatching {
            val volumeClass = Class.forName("android.os.storage.StorageVolume")
            val getPath = volumeClass.getMethod("getPath")
            val isRemovable = volumeClass.getMethod("isRemovable")
            val getVolumeState = StorageManager::class.java.getMethod(
                "getVolumeState",
                String::class.java,
            )
            val volumeList = StorageManager::class.java
                .getMethod("getVolumeList")
                .invoke(storageManager)
            val length = Array.getLength(volumeList)
            for (index in 0 until length) {
                val volume = Array.get(volumeList, index)
                val path = getPath.invoke(volume) as? String ?: continue
                val removable = isRemovable.invoke(volume) as? Boolean
                val state = getVolumeState.invoke(storageManager, path) as? String
                addRoot(File(path), storageVolumeLabel(null, File(path)), removable, state)
            }
        }
    }

    private fun storageVolumeDirectory(volume: StorageVolume): File? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            volume.directory?.let { return it }
        }
        return runCatching {
            StorageVolume::class.java.getMethod("getPath").invoke(volume) as? String
        }.getOrNull()?.let(::File)
    }

    private fun storageVolumeLabel(volume: StorageVolume?, file: File?): String? {
        val path = file?.let { normalizedFile(it).path }
        if (path == normalizedFile(Environment.getExternalStorageDirectory()).path) {
            return "内部存储"
        }
        return volume?.let {
            runCatching { it.getDescription(this) }.getOrNull()
        }?.takeIf { it.isNotBlank() }
    }

    private fun addExternalFilesRoots(
        addRoot: (File?, String?, Boolean?, String?) -> Unit,
    ) {
        for (dir in getExternalFilesDirs(null)) {
            val path = dir?.absolutePath ?: continue
            val marker = "/Android/data/"
            val markerIndex = path.indexOf(marker)
            if (markerIndex <= 0) continue
            addRoot(File(path.substring(0, markerIndex)), null, null, null)
        }
    }

    private fun addMountedDirectoryChildren(
        addRoot: (File?, String?, Boolean?, String?) -> Unit,
    ) {
        val parentPaths = listOf(
            "/storage",
            "/mnt/media_rw",
            "/mnt/usb_storage",
            "/mnt/usbhost",
            "/mnt/udisk",
            "/storage/udisk",
        )
        for (parentPath in parentPaths) {
            val parent = File(parentPath)
            val children = parent.listFiles() ?: continue
            for (child in children) {
                if (!child.isDirectory || child.name == "self") continue
                if (parentPath == "/storage" && child.name == "emulated") {
                    addRoot(File(child, "0"), "内部存储", false, null)
                    continue
                }
                if (child.name == "emulated") continue
                addRoot(child, storageRootFallbackLabel(child), null, null)
            }
        }
    }

    private fun storageRootFallbackLabel(file: File): String? {
        val name = file.name
        if (name.isBlank()) return null
        val looksLikeVolumeId = Regex("^[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}$").matches(name)
        return if (looksLikeVolumeId) "USB 存储 $name" else null
    }

    private fun listDirectoryChildren(path: String): List<File> {
        val directory = normalizedFile(File(path))
        if (!directory.exists() || !directory.isDirectory) {
            throw IllegalArgumentException("directory does not exist: $path")
        }
        val children = directory.listFiles()
            ?: throw IllegalStateException("directory is not readable: $path")
        return children
            .asSequence()
            .filter { it.isDirectory && it.canRead() && !it.name.startsWith(".") }
            .map { normalizedFile(it) }
            .distinctBy { it.path }
            .sortedBy { it.name.lowercase(Locale.ROOT) }
            .toList()
    }

    private fun storageEntry(
        file: File,
        isRoot: Boolean,
        label: String? = null,
        removable: Boolean? = null,
        state: String? = null,
    ): Map<String, Any?> {
        val normalized = normalizedFile(file)
        return mapOf(
            "path" to normalized.path,
            "name" to storageDisplayName(normalized, label),
            "isDirectory" to normalized.isDirectory,
            "isRoot" to isRoot,
            "isRemovable" to removable,
            "canRead" to normalized.canRead(),
            "canWrite" to normalized.canWrite(),
            "totalBytes" to normalized.totalSpace,
            "freeBytes" to normalized.freeSpace,
            "state" to state,
        )
    }

    private fun storageDisplayName(file: File, label: String?): String {
        label?.takeIf { it.isNotBlank() }?.let { return it }
        val primaryPath = normalizedFile(Environment.getExternalStorageDirectory()).path
        if (file.path == primaryPath) return "内部存储"
        return file.name.takeIf { it.isNotBlank() } ?: file.path
    }

    private fun normalizedFile(file: File): File {
        return runCatching { file.canonicalFile }.getOrDefault(file.absoluteFile)
    }

    private fun applyEdgeToEdgeSystemBars() {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            window.decorView.systemUiVisibility or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
    }

    private fun applyHighestRefreshRate() {
        val display = currentDisplay() ?: return
        val bestMode = highestRefreshMode(display)
        val refreshRate = bestMode?.refreshRate ?: display.refreshRate
        if (refreshRate <= 0f) return

        val attrs = window.attributes
        var changed = false
        if (bestMode != null && attrs.preferredDisplayModeId != bestMode.modeId) {
            attrs.preferredDisplayModeId = bestMode.modeId
            changed = true
        }
        if (abs(attrs.preferredRefreshRate - refreshRate) > 0.1f) {
            attrs.preferredRefreshRate = refreshRate
            changed = true
        }
        if (changed) window.attributes = attrs

        requestFlutterSurfaceFrameRate(refreshRate)
        requestDecorFrameRate(refreshRate)
        configureFrameRatePowerHints()
    }

    // Some OEM builds and ARR (adaptive refresh rate) devices ignore the
    // window-level preferredDisplayModeId/preferredRefreshRate unless the
    // content surface itself votes for a rate. Flutter renders into its own
    // SurfaceView surface and never casts that vote, so those devices keep
    // the panel at 60Hz — do it on the engine's surface ourselves.
    private fun requestFlutterSurfaceFrameRate(refreshRate: Float) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        voteFlutterSurfaceFrameRate(refreshRate)
        // The Flutter surface may not exist yet during onCreate/onResume;
        // retry once the decor view has gone through layout.
        window.decorView.post { voteFlutterSurfaceFrameRate(refreshRate) }
    }

    private fun voteFlutterSurfaceFrameRate(refreshRate: Float) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val surface = findSurfaceView(window.decorView)?.holder?.surface ?: return
        if (!surface.isValid) return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                surface.setFrameRate(
                    refreshRate,
                    Surface.FRAME_RATE_COMPATIBILITY_DEFAULT,
                    Surface.CHANGE_FRAME_RATE_ALWAYS,
                )
            } else {
                surface.setFrameRate(
                    refreshRate,
                    Surface.FRAME_RATE_COMPATIBILITY_DEFAULT,
                )
            }
        }
    }

    private fun findSurfaceView(view: View): SurfaceView? {
        if (view is SurfaceView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findSurfaceView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    // The system (power saving, other apps' votes, fold/rotate) can silently
    // switch the display mode back; re-assert our preference when that
    // happens. applyHighestRefreshRate only rewrites attributes on an actual
    // delta, so this does not loop.
    private fun registerDisplayListener() {
        if (displayListener != null) return
        val manager = getSystemService(DISPLAY_SERVICE) as? DisplayManager ?: return
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) {}

            override fun onDisplayRemoved(displayId: Int) {}

            override fun onDisplayChanged(displayId: Int) {
                if (displayId == currentDisplay()?.displayId) {
                    applyHighestRefreshRate()
                }
            }
        }
        displayListener = listener
        manager.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
    }

    private fun unregisterDisplayListener() {
        val listener = displayListener ?: return
        displayListener = null
        (getSystemService(DISPLAY_SERVICE) as? DisplayManager)
            ?.unregisterDisplayListener(listener)
    }

    @Suppress("DEPRECATION")
    private fun currentDisplay(): Display? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display ?: window.decorView.display
        } else {
            windowManager.defaultDisplay
        }
    }

    private fun highestRefreshMode(display: Display): Display.Mode? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
        val currentMode = display.mode ?: return null
        return display.supportedModes
            .filter {
                it.physicalWidth == currentMode.physicalWidth &&
                    it.physicalHeight == currentMode.physicalHeight
            }
            .maxByOrNull { it.refreshRate }
    }

    private fun requestDecorFrameRate(refreshRate: Float) {
        if (Build.VERSION.SDK_INT < 35) return
        runCatching {
            window.decorView.javaClass
                .getMethod("setRequestedFrameRate", Float::class.javaPrimitiveType)
                .invoke(window.decorView, refreshRate)
        }
    }

    private fun configureFrameRatePowerHints() {
        if (Build.VERSION.SDK_INT < 35) return
        runCatching {
            window.javaClass
                .getMethod("setFrameRatePowerSavingsBalanced", Boolean::class.javaPrimitiveType)
                .invoke(window, false)
        }
        runCatching {
            window.javaClass
                .getMethod("setFrameRateBoostOnTouchEnabled", Boolean::class.javaPrimitiveType)
                .invoke(window, true)
        }
    }
}
