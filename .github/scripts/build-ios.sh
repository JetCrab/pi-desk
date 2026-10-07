#!/usr/bin/env bash
set -euo pipefail
root="$GITHUB_WORKSPACE"
build="$root/temp/build/ios-ci/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
output="$root/temp/package/clients/ios/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
mkdir -p "$build" "$output"
xcodegen generate --spec apps/ios/project.yml
project=apps/ios/PiDesk.xcodeproj
xcodebuild -project "$project" -scheme PiDesk -configuration Release \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$build/simulator" \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=NO build
simulator="$build/simulator/Build/Products/Release-iphonesimulator/PiDesk.app"
[[ -d "$simulator" && -s "$simulator/PiDesk" ]]
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$simulator/Info.plist")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$simulator/Info.plist")" == com.jetcrab.ios ]]
lipo -verify_arch arm64 "$simulator/PiDesk"
ditto -c -k --sequesterRsrc --keepParent "$simulator" "$output/pi-desk-ios-$version-simulator-arm64.zip"
signing=(CODE_SIGNING_ALLOWED=NO)
if [[ "${APPLE_SIGNED:-false}" == true ]]; then
  signing=(CODE_SIGN_STYLE=Manual "DEVELOPMENT_TEAM=$IOS_TEAM_ID" "PROVISIONING_PROFILE_SPECIFIER=$IOS_PROFILE_UUID" "CODE_SIGN_IDENTITY=$APPLE_SIGNING_IDENTITY" "OTHER_CODE_SIGN_FLAGS=--keychain $APPLE_KEYCHAIN")
fi
archive="$build/PiDesk.xcarchive"
xcodebuild -project "$project" -scheme PiDesk -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$build/device" \
  -archivePath "$archive" "${signing[@]}" archive
app="$archive/Products/Applications/PiDesk.app"
[[ -d "$app" && -s "$app/PiDesk" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")" == com.jetcrab.ios ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist")" == "$version" ]]
lipo -verify_arch arm64 "$app/PiDesk"
if [[ "${APPLE_SIGNED:-false}" == true ]]; then
  codesign --verify --deep --strict "$app"
  xcodebuild -exportArchive -archivePath "$archive" -exportPath "$build/export" \
    -exportOptionsPlist "$IOS_EXPORT_OPTIONS"
  ipa=("$build/export/"*.ipa)
  [[ ${#ipa[@]} == 1 && -s "${ipa[0]}" ]]
  cp "${ipa[0]}" "$output/pi-desk-ios-$version-$IOS_EXPORT_METHOD.ipa"
else
  ditto -c -k --sequesterRsrc --keepParent "$archive" "$output/pi-desk-ios-$version-device-unsigned.xcarchive.zip"
fi
(cd "$output" && shasum -a 256 ./* > SHA256SUMS.txt)
{
  echo '## iOS 构建结果'
  echo "- 版本：$version"
  echo '- 已生成 arm64 模拟器应用及设备归档，未运行功能测试。'
  if [[ "${APPLE_SIGNED:-false}" == true ]]; then
    echo "- 已签名导出：$IOS_EXPORT_METHOD；App Store 类型 IPA 仍需 TestFlight/App Store 分发。"
  else
    echo '- 设备归档未签名，不能直接安装到 iPhone；需要 Apple 开发者证书及描述文件。'
  fi
} >> "$GITHUB_STEP_SUMMARY"
