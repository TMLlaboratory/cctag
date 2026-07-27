import type { IncomingFile } from "../attachments.js";

/** The subset of Slack's file object cctag reads off a message event. */
interface SlackEventFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

export interface FileBearingEvent {
  files?: SlackEventFile[];
}

/**
 * Normalizes the `files` array Slack puts on a message/app_mention event
 * (pasting an image into the composer uploads it as a file and attaches it
 * here — it never appears in the event's `text`).
 *
 * Entries without an id are dropped: the id is what both the standalone
 * download path and the Hub's `fetch_file` authorization key off, and Slack
 * can include placeholder entries for uploads that are still in flight.
 */
export function incomingFilesFrom(event: FileBearingEvent): IncomingFile[] {
  const files = event.files;
  if (!Array.isArray(files)) return [];
  const out: IncomingFile[] = [];
  for (const f of files) {
    if (!f?.id) continue;
    out.push({
      id: f.id,
      // A screen-recording or snippet upload can arrive with no name at all.
      name: f.name || f.title || f.id,
      mimetype: f.mimetype,
      size: f.size,
      downloadUrl: f.url_private_download,
    });
  }
  return out;
}

/**
 * Slack delivers a message that carries an upload with `subtype: "file_share"`.
 * The message handlers drop subtyped messages wholesale (joins, edits, ...),
 * which would silently swallow every image-bearing reply — so this one subtype
 * has to be let through explicitly.
 */
export function isPlainOrFileShare(subtype: string | undefined): boolean {
  return !subtype || subtype === "file_share";
}
