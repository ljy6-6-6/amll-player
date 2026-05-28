use ffmpeg_audio::SourceAudioInfo;
use serde::*;

#[derive(Serialize, Deserialize, PartialEq, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioQuality {
    pub sample_rate: Option<u32>,
    pub bits_per_coded_sample: Option<u32>,
    pub bits_per_sample: Option<u32>,
    pub channels: Option<u32>,
    pub sample_format: String,
    pub codec: String,
}

impl AudioQuality {
    pub fn from_source_info(info: &SourceAudioInfo) -> Self {
        let sample_format_str = info.sample_fmt.as_deref().unwrap_or("unknown");

        let bits_per_sample = if info.bits_per_sample > 0 {
            Some(info.bits_per_sample.cast_unsigned())
        } else {
            None
        };

        Self {
            sample_rate: Some(info.sample_rate.cast_unsigned()),
            bits_per_coded_sample: None,
            bits_per_sample,
            channels: Some(info.channels.cast_unsigned()),
            codec: info
                .codec_name
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            sample_format: sample_format_str.to_string(),
        }
    }
}
