import java.util.Properties

plugins {
    id("com.android.application")
}

val releaseSigningPath = providers.gradleProperty("piDeskSigningProperties").orNull
val releaseKeyStorePath = providers.gradleProperty("piDeskSigningKeyStore").orNull
val releaseSigningFile = rootProject.file(releaseSigningPath ?: "signing/release.properties")
val releaseKeyStore = rootProject.file(releaseKeyStorePath ?: "signing/pi-desk-release.p12")
val releaseSigning = Properties()
val releaseSigningError = if (releaseSigningFile.exists()) {
    runCatching {
        releaseSigningFile.inputStream().use { releaseSigning.load(it) }
        val missingProperties = listOf("storePassword", "keyPassword").filter {
            releaseSigning.getProperty(it).isNullOrBlank()
        }
        when {
            missingProperties.isNotEmpty() ->
                "签名配置缺少有效字段：${missingProperties.joinToString()}"
            !releaseKeyStore.isFile ->
                "缺少发布密钥文件，请检查 piDeskSigningKeyStore 或本地签名路径"
            else -> null
        }
    }.getOrElse {
        "无法读取签名配置，请检查文件格式和读取权限"
    }
} else if (releaseSigningPath != null || releaseKeyStorePath != null) {
    "未找到显式指定的签名配置，请检查 piDeskSigningProperties"
} else {
    null
}
val hasReleaseSigning = releaseSigningFile.exists() && releaseSigningError == null

val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    doLast {
        releaseSigningError?.let { throw GradleException("发布签名配置无效：$it") }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(validateReleaseSigning)
}

android {
    namespace = "com.jetcrab.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.jetcrab.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 9
        versionName = "1.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseKeyStore
                storePassword = releaseSigning.getProperty("storePassword")
                keyAlias = "pi-desk-release"
                keyPassword = releaseSigning.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("release") {
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += "kotlin/**"
    }

    lint {
        // 与参考实现保持已验证的 Android 15 IME/窗口契约；平台升级单独验收。
        disable += setOf("OldTargetApi", "GradleDependency")
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
