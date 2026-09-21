// 從 mp4 / mov / m4a 取出 AAC 音軌，包成 .aac（ADTS）檔，只上傳這個給字幕服務。
// 不重新編碼、不把整部影片讀進記憶體：先用 mp4box.js 解析 moov 找出每個音訊樣本在檔案裡的位置，
// 再照位置分段讀出來。2.5 小時的課約 140 MB，比整部影片小很多。
// 不是 AAC-LC、或是分段式（fragmented）mp4 就回傳 null，呼叫端改上傳整個檔案。
// 也會照 edit list 去掉播放時被略過的開頭，讓字幕時間對得上影片。
(() => {
  const WINDOW = 16 << 20;
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  async function findTopBox(file, type) {
    let pos = 0;
    while (pos + 8 <= file.size) {
      const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
      let size = head.getUint32(0);
      const name = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
      if (size === 1) size = Number(head.getBigUint64(8));
      else if (size === 0) size = file.size - pos;
      if (name === type) return { start: pos, size };
      if (size < 8) return null;
      pos += size;
    }
    return null;
  }

  async function audioTrack(file) {
    const ftyp = await findTopBox(file, 'ftyp');
    const moov = await findTopBox(file, 'moov');
    if (!ftyp || !moov || moov.size > 256 << 20) return null;
    // 只餵 ftyp + moov 給 mp4box：樣本位置記的是整個檔案的絕對位置，資料我們自己讀
    const buf = await new Blob([file.slice(ftyp.start, ftyp.start + ftyp.size),
      file.slice(moov.start, moov.start + moov.size)]).arrayBuffer();
    buf.fileStart = 0;
    const mp4 = MP4Box.createFile();
    let info = null;
    mp4.onReady = (i) => { info = i; };
    mp4.onError = () => {};
    mp4.appendBuffer(buf);
    mp4.flush();
    const track = info && info.audioTracks[0];
    if (!track || track.codec !== 'mp4a.40.2') return null;
    const trak = mp4.getTrackById(track.id);
    const samples = trak.samples;
    const rateIndex = RATES.indexOf(track.audio.sample_rate);
    const channels = track.audio.channel_count;
    if (!samples || !samples.length || rateIndex < 0 || channels < 1 || channels > 7) return null;

    // edit list：播放時開頭要略過一段聲音（AAC 編碼延遲，或用 -c copy 剪過的片段會多出前一段），
    // 或先空白一段。單獨的 .aac 沒有這個資訊，不處理的話字幕會整體偏移（實測剪過的片段差 0.77 秒）。
    let delay = 0, skip = 0;
    for (const e of (trak.edts && trak.edts.elst ? trak.edts.elst.entries : [])) {
      if (e.media_time === -1) { delay += e.segment_duration / info.timescale; continue; }
      skip = e.media_time;
      break;
    }
    let first = 0;
    while (first < samples.length - 1 && samples[first].dts + samples[first].duration <= skip) first++;
    // 丟掉整格略過的聲音，剩下不滿一格的零頭（最多 21 毫秒）交給字幕服務平移時間
    const shift = delay - (skip - samples[first].dts) / track.timescale;
    return { samples: samples.slice(first), rateIndex, channels, shift };
  }

  // 回傳 { blob, shift }：shift 秒數加到字幕時間上才會對齊影片；格式不支援時回傳 null
  window.extractAudio = async function extractAudio(file, onProgress = () => {}) {
    const track = await audioTrack(file);
    if (!track) return null;
    const { samples, rateIndex, channels, shift } = track;
    const parts = [];
    let out = new Uint8Array(4 << 20), used = 0;
    const put = (bytes) => {
      if (used + bytes.length > out.length) { parts.push(out.subarray(0, used)); out = new Uint8Array(Math.max(4 << 20, bytes.length)); used = 0; }
      out.set(bytes, used); used += bytes.length;
    };
    let winStart = 0, win = new Uint8Array(0);
    for (let i = 0; i < samples.length; i++) {
      const { offset, size } = samples[i];
      if (offset < winStart || offset + size > winStart + win.length) {
        winStart = offset;
        win = new Uint8Array(await file.slice(offset, offset + Math.max(WINDOW, size)).arrayBuffer());
        onProgress(i / samples.length);
      }
      const len = size + 7;
      // ADTS 標頭：AAC-LC、無 CRC、buffer fullness 0x7FF（和 ffmpeg -f adts 一樣）
      put(Uint8Array.of(0xFF, 0xF1, (1 << 6) | (rateIndex << 2) | (channels >> 2),
        ((channels & 3) << 6) | (len >> 11), (len >> 3) & 0xFF, ((len & 7) << 5) | 0x1F, 0xFC));
      put(win.subarray(offset - winStart, offset - winStart + size));
    }
    parts.push(out.subarray(0, used));
    onProgress(1);
    return { blob: new Blob(parts, { type: 'audio/aac' }), shift };
  };
})();
