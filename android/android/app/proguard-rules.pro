# --- flutter_audio_tagger / jaudiotagger -----------------------------------
# jaudiotagger uses reflection (Class.getConstructor / .getMethod) when it
# clones tag frame bodies and when it picks tag readers by class name. Without
# these keep rules, R8 renames them to `a2.f`, `a2.g` etc. and reflection
# throws `NoSuchMethodException: Error finding constructor to create copy`,
# which surfaces as "no cover and no lyric on every downloaded song".
-keep class org.jaudiotagger.** { *; }
-keepclassmembers class org.jaudiotagger.** {
    public <init>(...);
    <init>(...);
}
-keepnames class org.jaudiotagger.**
-dontwarn org.jaudiotagger.**
-dontwarn java.awt.**
-dontwarn javax.swing.**
-dontwarn javax.imageio.**

# The Android port uses these instead of java.awt.image.BufferedImage.
-keep class com.creadv.flutter_audio_tagger.** { *; }
-keepnames class com.creadv.flutter_audio_tagger.**

# Flutter / platform-channel boilerplate (Flutter's own default rules already
# cover most of this, but keep the safety net so a future plugin upgrade
# doesn't quietly start failing again).
-keep class io.flutter.plugin.** { *; }
-keep class io.flutter.embedding.** { *; }
