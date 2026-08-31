/**
 * The Hub's WebSocket frame ceiling, in its own module.
 *
 * Separate from hub/index.ts for the same reason hub-url.ts is: that file runs
 * `main()` at import time, so a test importing anything from it starts a real
 * server and hangs. This one has no side effects.
 */

/**
 * The largest WebSocket frame the Hub will accept, from the file cap.
 *
 * `ws` defaults `maxPayload` to 100 MiB, and CCTAG_MAX_FILE_MB was NOT holding
 * that line: `upload_file` compares sizes only after the whole frame has been
 * received and JSON.parsed, so an oversized upload was rejected having already
 * been paid for in memory. The Hub this was measured on has 954 MB of RAM, no
 * swap, two Hub processes, and `MemoryMax=infinity` — a single 100 MB frame
 * becomes the frame, the parsed base64 string, and the decoded buffer, and the
 * OOM killer's choice of victim need not be the process at fault.
 *
 * Setting it makes the limit real: `ws` compares against the length declared in
 * the frame header, *before* reading the payload, and fails the connection with
 * close code 1009 (verified in ws/lib/receiver.js, not assumed). A well-behaved
 * Spoke never reaches this — it clamps to the cap reported at registration — so
 * this is the floor under a Spoke that is old, or simply not ours.
 *
 * Base64 is 4/3 of the bytes it encodes, plus a small JSON envelope (channel,
 * filename, caption). The 1 MiB of headroom covers the envelope; the 8 MiB
 * floor keeps a deliberately tiny CCTAG_MAX_FILE_MB from also shrinking the
 * ordinary, fileless RPC traffic that shares this socket.
 */
export function maxFramePayload(maxFileBytes: number): number {
  const base64 = Math.ceil((maxFileBytes * 4) / 3);
  return Math.max(base64 + 1024 * 1024, 8 * 1024 * 1024);
}
