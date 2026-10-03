//! sysvol.rs — drive the OS master volume instead of only the WebView's
//! audio element, so the app's slider moves the laptop's actual sound
//! (speakers, headphones, Bluetooth).
//!
//! Windows exposes the mixer through COM (`IMMDeviceEnumerator` →
//! `IAudioEndpointVolume`). There is no cross-platform core-audio binding
//! here, so every command reports a plain error off Windows and the
//! frontend falls back to element-only volume.

/// One snapshot of the master volume: level plus mute state.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeState {
    /// 0.0 – 1.0 master scalar.
    pub level: f32,
    pub muted: bool,
}

impl VolumeState {
    /// Volume is also a UI concern: the element keeps playing, so the level
    /// always arrives clamped and NaN-free.
    fn clean(level: f32, muted: bool) -> Self {
        let level = if level.is_finite() {
            level.clamp(0.0, 1.0)
        } else {
            1.0
        };
        Self { level, muted }
    }
}

// ---------------------------------------------------------------- Windows -
#[cfg(windows)]
mod platform {
    use super::VolumeState;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };

    /// The default render endpoint (speakers / headphones / Bluetooth
    /// headset), with its master volume interface.
    fn endpoint() -> Result<IAudioEndpointVolume, String> {
        unsafe {
            // Each command runs on its own worker thread, so COM has to be
            // started and stopped per call.
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let owned = hr.is_ok();
            let result = master_endpoint();
            if owned {
                CoUninitialize();
            }
            result
        }
    }

    unsafe fn master_endpoint() -> Result<IAudioEndpointVolume, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("no audio endpoint ({e})"))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("default endpoint ({e})"))?;
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("volume interface ({e})"))
    }

    pub fn read() -> Result<VolumeState, String> {
        let volume = endpoint()?;
        unsafe {
            let level = volume.GetMasterVolumeLevelScalar().unwrap_or(1.0);
            let muted = volume.GetMute().map(|m| m.as_bool()).unwrap_or(false);
            Ok(VolumeState::clean(level, muted))
        }
    }

    pub fn write(level: Option<f32>, muted: Option<bool>) -> Result<VolumeState, String> {
        let volume = endpoint()?;
        unsafe {
            if let Some(level) = level {
                // Deterministic curve: Windows' own curve is non-linear, and
                // the app's linear slider should feel linear.
                volume
                    .SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null())
                    .map_err(|e| format!("set volume failed ({e})"))?;
            }
            if let Some(muted) = muted {
                volume
                    .SetMute(muted, std::ptr::null())
                    .map_err(|e| format!("set mute failed ({e})"))?;
            }
            let now = volume
                .GetMasterVolumeLevelScalar()
                .unwrap_or(level.unwrap_or(1.0));
            let now_muted = volume.GetMute().map(|m| m.as_bool()).unwrap_or(false);
            Ok(VolumeState::clean(now, now_muted))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::VolumeState;

    pub fn read() -> Result<VolumeState, String> {
        Err("system volume control is only available on Windows".into())
    }

    pub fn write(_level: Option<f32>, _muted: Option<bool>) -> Result<VolumeState, String> {
        Err("system volume control is only available on Windows".into())
    }
}

// ---------------------------------------------------------------- commands -
/// Current OS master volume. The frontend polls this so hardware volume keys
/// move the app's slider, not the other way round.
#[tauri::command]
pub fn system_volume() -> Result<VolumeState, String> {
    platform::read()
}

/// Set the OS master volume (and/or mute). Answers with what Windows actually
/// applied, since the endpoint may clamp.
#[tauri::command]
pub fn set_system_volume(level: Option<f32>, muted: Option<bool>) -> Result<VolumeState, String> {
    platform::write(level, muted)
}

#[cfg(test)]
mod tests {
    use super::VolumeState;

    #[test]
    fn state_is_clamped_and_nan_safe() {
        assert_eq!(VolumeState::clean(-2.0, false).level, 0.0);
        assert_eq!(VolumeState::clean(4.0, false).level, 1.0);
        assert_eq!(VolumeState::clean(f32::NAN, true).level, 1.0);
        assert!(VolumeState::clean(0.5, true).muted);
    }
}
