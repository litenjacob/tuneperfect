use crate::audio::device::{device_display_name, DeviceManager};
#[cfg(target_os = "macos")]
use crate::audio::device::{device_transport, is_wireless, local_monitor_priority};
use crate::error::AppError;
use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Serialize, specta::Type)]
pub struct Microphone {
    /// Stable device ID (cpal `DeviceId` serialized via `Display`). Preferred for
    /// persisting a mic selection. `None` if the backend can't report an ID.
    id: Option<String>,
    name: String,
    channels: u16,
}

pub fn get_microphones() -> Result<Vec<Microphone>, AppError> {
    let mut microphones = Vec::new();

    let host = cpal::default_host();
    let default = host.default_input_device();
    let default_id = default
        .as_ref()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    #[cfg(target_os = "macos")]
    let prefer_local = default
        .as_ref()
        .is_some_and(|device| is_wireless(device_transport(device)));
    let devices = host.devices()?;
    for device in devices {
        let Ok(config) = device.default_input_config() else {
            continue;
        };
        let Ok(description) = device.description() else {
            continue;
        };

        let id = device.id().ok().map(|id| id.to_string());
        let rank = if id.is_some() && id == default_id {
            0
        } else {
            1
        };
        #[cfg(target_os = "macos")]
        let rank = if prefer_local {
            local_monitor_priority(device_transport(&device)).unwrap_or(2 + rank)
        } else {
            rank
        };
        microphones.push((
            rank,
            Microphone {
                id,
                name: device_display_name(&description),
                channels: config.channels(),
            },
        ));
    }

    microphones.sort_by_key(|(rank, _)| *rank);
    Ok(microphones.into_iter().map(|(_, mic)| mic).collect())
}

pub fn get_monitor_output() -> Result<Option<String>, AppError> {
    Ok(DeviceManager::new()?
        .monitor_output()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string()))
}
