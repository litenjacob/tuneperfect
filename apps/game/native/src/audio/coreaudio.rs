use cpal::{traits::DeviceTrait, Device};
use objc2_core_audio::{
    kAudioDevicePropertyTransportType, kAudioHardwarePropertyTranslateUIDToDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioObjectGetPropertyData, AudioObjectPropertyAddress,
};
use objc2_core_foundation::{CFRetained, CFString};
use std::{ffi::c_void, mem::size_of, ptr::NonNull};

pub fn transport(device: &Device) -> Option<u32> {
    let uid = CFString::from_str(device.id().ok()?.id());
    let qualifier = CFRetained::as_ptr(&uid).as_ptr();
    let object = property(
        kAudioObjectSystemObject as u32,
        kAudioHardwarePropertyTranslateUIDToDevice,
        size_of::<*mut CFString>() as u32,
        std::ptr::from_ref(&qualifier).cast(),
    )?;
    property(
        object,
        kAudioDevicePropertyTransportType,
        0,
        std::ptr::null(),
    )
}

fn property(
    object: u32,
    selector: u32,
    qualifier_size: u32,
    qualifier: *const c_void,
) -> Option<u32> {
    let address = AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut result = 0u32;
    let mut size = size_of::<u32>() as u32;
    // Both queried CoreAudio properties produce one UInt32. The UID qualifier is
    // passed by reference and its CFString is held alive for the synchronous call.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&address),
            qualifier_size,
            qualifier,
            NonNull::from(&mut size),
            NonNull::from(&mut result).cast(),
        )
    };
    (status == 0 && size == size_of::<u32>() as u32).then_some(result)
}
