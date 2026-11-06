plugins {
    id("com.android.application") version "9.2.1" apply false
}

providers.gradleProperty("piDeskBuildDir").orNull?.let { output ->
    val outputDirectory = rootProject.file(output)
    allprojects {
        layout.buildDirectory.set(outputDirectory.resolve(if (path == ":") "root" else name))
    }
}
