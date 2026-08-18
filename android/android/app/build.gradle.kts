import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

fun currentGitBranch(): String? = runCatching {
    val process = ProcessBuilder("git", "rev-parse", "--abbrev-ref", "HEAD")
        .directory(rootProject.projectDir.parentFile)
        .redirectErrorStream(true)
        .start()
    process.inputStream.bufferedReader().use { it.readText() }.trim()
        .takeIf { process.waitFor() == 0 }
}.getOrNull()

val appChannel = (
    providers.gradleProperty("app.channel").orNull
        ?: System.getenv("APP_CHANNEL")
        ?: if (currentGitBranch() == "dev") "dev" else "main"
    ).trim().lowercase()
require(appChannel == "main" || appChannel == "dev") {
    "app.channel must be either 'main' or 'dev', but was '$appChannel'."
}

val isDevChannel = appChannel == "dev"
val appId = if (isDevChannel) "com.twilight.echo.dev" else "com.twilight.echo"
val appLabel = if (isDevChannel) "Twilight Echodev" else "Twilight Echo"

val targetPlatformToAbi = mapOf(
    "android-arm" to "armeabi-v7a",
    "android-arm64" to "arm64-v8a",
)
val requestedAbis = (project.findProperty("target-platform") as? String)
    ?.split(",")
    ?.mapNotNull { targetPlatformToAbi[it.trim()] }
    ?.toSet()
    ?.takeIf { it.isNotEmpty() }
    ?: setOf("arm64-v8a")

val signingPropertiesFile = rootProject.file("signing/$appChannel.properties")
val signingProperties = Properties().apply {
    if (signingPropertiesFile.isFile) {
        signingPropertiesFile.inputStream().use(::load)
    }
}
val signingStoreFile = signingProperties.getProperty("storeFile")
    ?.takeIf { it.isNotBlank() }
    ?.let { path ->
        File(path).let { file ->
            if (file.isAbsolute) file else signingPropertiesFile.parentFile.resolve(path)
        }
    }
val signingStorePassword = signingProperties.getProperty("storePassword")
val signingKeyAlias = signingProperties.getProperty("keyAlias")
val signingKeyPassword = signingProperties.getProperty("keyPassword")
val releaseSigningReady = signingStoreFile?.isFile == true &&
    !signingStorePassword.isNullOrBlank() &&
    !signingKeyAlias.isNullOrBlank() &&
    !signingKeyPassword.isNullOrBlank()

android {
    namespace = "com.twilight.echo"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("channelRelease") {
                storeFile = requireNotNull(signingStoreFile)
                storePassword = signingStorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    defaultConfig {
        applicationId = appId
        minSdk = flutter.minSdkVersion
        targetSdk = 35
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["appLabel"] = appLabel
    }

    buildTypes {
        release {
            ndk {
                abiFilters.clear()
                abiFilters += requestedAbis
            }
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("channelRelease")
            }
            // jaudiotagger inside flutter_audio_tagger uses reflection to find
            // frame-body copy constructors. When R8 minifies the release
            // build, those classes get renamed (`a2.f` etc.) and the
            // reflective lookup throws `NoSuchMethodException`, which is why
            // released builds were silently producing files with no cover or
            // lyric tags. Keep R8 off by default; the keep rules in
            // proguard-rules.pro mean that re-enabling minification later
            // won't reintroduce the regression.
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { task ->
        task.project == project && task.name.contains("release", ignoreCase = true)
    }
    if (buildsRelease && !releaseSigningReady) {
        throw GradleException(
            "Missing fixed $appChannel signing configuration. " +
                "Create ${signingPropertiesFile.path} and its referenced keystore.",
        )
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("wang.harlon.quickjs:wrapper-android:2.4.0")

    // Compile against jaudiotagger without bundling another copy. The
    // flutter_audio_tagger plugin already packages jaudiotagger-android.jar;
    // our app channel uses the same runtime classes but avoids returning the
    // whole edited audio file through MethodChannel.
    compileOnly("net.jthink:jaudiotagger:3.0.1")
}
