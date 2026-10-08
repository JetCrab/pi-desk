use super::*;

#[test]
fn update_defaults_are_startup_check_periodic_none_and_stable() {
    let package = default_server_config().package.unwrap();
    assert_eq!(package.startup_update, UpdatePolicy::Check);
    assert_eq!(package.periodic_update, UpdatePolicy::None);
    assert_eq!(package.channel, ReleaseChannel::Stable);
    let value: PackageConfig =
        serde_json::from_value(serde_json::json!({"name":"@jetcrab/pi-desk"})).unwrap();
    assert_eq!(value.startup_update, UpdatePolicy::Check);
    assert_eq!(value.periodic_update, UpdatePolicy::None);
    assert_eq!(value.channel, ReleaseChannel::Stable);
}

#[test]
fn legacy_update_preferences_are_preserved_but_not_written_again() {
    for enabled in [true, false] {
        let value: PackageConfig = serde_json::from_value(serde_json::json!({
            "name":"@jetcrab/pi-desk", "autoUpdateOnStart":enabled, "periodicUpdateCheck":enabled
        }))
        .unwrap();
        let expected = if enabled {
            UpdatePolicy::Update
        } else {
            UpdatePolicy::None
        };
        assert_eq!(value.startup_update, expected);
        assert_eq!(value.periodic_update, expected);
        let saved = serde_json::to_value(value).unwrap();
        assert!(saved.get("autoUpdateOnStart").is_none());
        assert!(saved.get("periodicUpdateCheck").is_none());
        assert_eq!(saved["channel"], "stable");
    }
    let value: PackageConfig =
        serde_json::from_value(serde_json::json!({"name":"pkg", "autoUpdate":true})).unwrap();
    assert_eq!(value.startup_update, UpdatePolicy::Update);
}

#[test]
fn release_channel_never_installs_prerelease_into_stable_and_can_switch_back() {
    let mut package = default_server_config().package.unwrap();
    assert!(!crate::packages::should_select_version(
        &package,
        Some("1.0.1-dev.1"),
        Some("1.0.0")
    ));
    assert!(crate::packages::should_select_version(
        &package,
        Some("1.0.0"),
        Some("1.0.1-dev.9")
    ));
    assert!(!crate::packages::should_select_version(
        &package,
        Some("1.0.0"),
        Some("1.0.0")
    ));
    package.channel = ReleaseChannel::Dev;
    assert!(crate::packages::should_select_version(
        &package,
        Some("1.0.1-dev.12"),
        Some("1.0.1-dev.9")
    ));
    assert!(!crate::packages::should_select_version(
        &package,
        Some("1.0.1-dev.9"),
        Some("1.0.1-dev.12")
    ));
}

#[test]
fn explicit_update_policy_wins_and_invalid_modes_are_rejected() {
    let value: PackageConfig = serde_json::from_value(serde_json::json!({
        "name":"pkg", "autoUpdateOnStart":true, "periodicUpdateCheck":true,
        "startupUpdate":"none", "periodicUpdate":"check", "channel":"dev"
    }))
    .unwrap();
    assert_eq!(value.startup_update, UpdatePolicy::None);
    assert_eq!(value.periodic_update, UpdatePolicy::Check);
    assert_eq!(value.channel, ReleaseChannel::Dev);
    for extra in [
        serde_json::json!({"startupUpdate":"invalid"}),
        serde_json::json!({"channel":"other"}),
    ] {
        let mut input = serde_json::json!({"name":"pkg"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(serde_json::from_value::<PackageConfig>(input).is_err());
    }
}
