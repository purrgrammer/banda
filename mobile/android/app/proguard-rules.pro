# R8 shrinks the release build. Capacitor and its plugins ship their own keep rules; these cover what does not.

# iroh's Kotlin bindings (uniffi) reach libiroh_ffi through JNA, which finds methods, Structure fields and callbacks
# by reflection: renaming or removing any of them breaks the native calls at run time, not at build time.
-keep class computer.iroh.** { *; }
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn java.awt.**

# The barcode scanner (OutSystems, under @capacitor/barcode-scanner) annotates its models for Gson but never ships
# Gson: the annotations are dead weight. Its models still keep their names, as the scanner hands them between
# activities.
-dontwarn com.google.gson.annotations.SerializedName
-keep class com.outsystems.plugins.barcode.model.** { *; }
