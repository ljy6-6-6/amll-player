use crate::AudioInfo;
use ffmpeg_audio::AudioReader;

pub fn build_audio_info(reader: &AudioReader) -> AudioInfo {
    let mut info = AudioInfo::default();

    let metadata = reader.metadata();

    let get_meta = |search_key: &str| -> String {
        metadata
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(search_key))
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };

    info.name = get_meta("title");
    info.artist = get_meta("artist");
    info.album = get_meta("album");
    info.lyric = get_meta("lyrics");
    info.comment = get_meta("comment");

    if let Some(cover) = reader.cover() {
        info.cover = Some(cover.data);
        info.cover_media_type = cover.mime_type.unwrap_or_default();
    }

    if let Some(duration) = reader.duration() {
        info.duration = duration.as_secs_f64();
    }

    info
}
