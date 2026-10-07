#!/usr/bin/env bash
set -euo pipefail
umask 077
platform=$1
operation=$2
root="$RUNNER_TEMP/pi-desk-apple-$platform-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
keychain="$root/build.keychain-db"
if [[ "$operation" == cleanup ]]; then
  if [[ -f "$keychain" ]]; then security delete-keychain "$keychain" || true; fi
  if [[ -f "$root/profile-path" ]]; then rm -f -- "$(< "$root/profile-path")"; fi
  rm -rf -- "$root"
  exit 0
fi
[[ "$operation" == prepare && ( "$platform" == macos || "$platform" == ios ) ]]
mkdir -p "$root"
if [[ "$platform" == macos ]]; then
  certificate="${MACOS_CERTIFICATE_BASE64:-}"
  password="${MACOS_CERTIFICATE_PASSWORD:-}"
else
  certificate="${IOS_CERTIFICATE_BASE64:-}"
  password="${IOS_CERTIFICATE_PASSWORD:-}"
fi
if [[ -z "$certificate" ]]; then
  if [[ -n "$password" || ( "$platform" == ios && -n "${IOS_PROVISION_PROFILE_BASE64:-}" ) ]]; then
    echo 'Apple 签名配置不完整' >&2
    exit 1
  fi
  echo 'signed=false' >> "$GITHUB_OUTPUT"
  if [[ "$platform" == macos ]]; then echo 'APPLE_SIGNING_IDENTITY=-' >> "$GITHUB_ENV"; fi
  echo '未配置 Apple 开发者签名，生成明确标记的未签名验证制品。'
  exit 0
fi
[[ -n "$password" ]] || { echo '缺少 Apple 证书密码' >&2; exit 1; }
if [[ "$platform" == ios && -z "${IOS_PROVISION_PROFILE_BASE64:-}" ]]; then
  echo '缺少 iOS 描述文件' >&2; exit 1
fi
printf '%s' "$certificate" | base64 -D > "$root/distribution.p12"
keychain_password=$(openssl rand -hex 24)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$root/distribution.p12" -P "$password" -k "$keychain" -T /usr/bin/codesign -T /usr/bin/security > /dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" > /dev/null
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security find-identity -v -p codesigning "$keychain" > "$root/identities"
identity=$(awk '/"/ { print $2; exit }' "$root/identities")
[[ "$identity" =~ ^[A-Fa-f0-9]{40}$ ]] || { echo '没有可用的 Apple 签名身份' >&2; exit 1; }
echo "APPLE_KEYCHAIN=$keychain" >> "$GITHUB_ENV"
echo "APPLE_SIGNING_IDENTITY=$identity" >> "$GITHUB_ENV"
if [[ "$platform" == ios ]]; then
  printf '%s' "$IOS_PROVISION_PROFILE_BASE64" | base64 -D > "$root/profile.mobileprovision"
  security cms -D -i "$root/profile.mobileprovision" > "$root/profile.plist"
  python3 - "$root" <<'PY'
import datetime, os, pathlib, plistlib, re, shutil, sys
root = pathlib.Path(sys.argv[1])
with (root/'profile.plist').open('rb') as stream:
    profile = plistlib.load(stream)
assert profile['ExpirationDate'] > datetime.datetime.utcnow(), 'iOS 描述文件已过期'
team = profile['TeamIdentifier'][0]
uuid = profile['UUID']
assert re.fullmatch(r'[A-Z0-9]+', team) and re.fullmatch(r'[A-Fa-f0-9-]+', uuid)
assert profile['Entitlements']['application-identifier'] == team + '.com.jetcrab.ios', '描述文件必须匹配 com.jetcrab.ios'
method = 'debugging' if profile['Entitlements'].get('get-task-allow') else 'enterprise' if profile.get('ProvisionsAllDevices') else 'release-testing' if profile.get('ProvisionedDevices') else 'app-store-connect'
path = pathlib.Path.home()/'Library/MobileDevice/Provisioning Profiles'/(uuid+'.mobileprovision')
path.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(root/'profile.mobileprovision', path)
(root/'profile-path').write_text(str(path))
with open(os.environ['GITHUB_ENV'], 'a') as stream:
    stream.write(f'IOS_TEAM_ID={team}\nIOS_PROFILE_UUID={uuid}\nIOS_EXPORT_METHOD={method}\n')
options = {'method': method, 'teamID': team, 'signingStyle': 'manual', 'provisioningProfiles': {'com.jetcrab.ios': uuid}, 'manageAppVersionAndBuildNumber': False}
with (root/'export-options.plist').open('wb') as stream:
    plistlib.dump(options, stream)
PY
  echo "IOS_EXPORT_OPTIONS=$root/export-options.plist" >> "$GITHUB_ENV"
fi
echo 'signed=true' >> "$GITHUB_OUTPUT"
echo 'Apple 签名已准备，仅在本次 Runner 的临时 Keychain 内使用。'
