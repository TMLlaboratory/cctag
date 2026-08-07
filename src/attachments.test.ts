import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromptWithAttachments,
  countImages,
  isOutboundAttachable,
  outboxAdditions,
  outboxDir,
  readOutboundAttachments,
  sanitizeAttachmentName,
  saveIncomingFiles,
  snapshotOutbox,
  WrittenFileTracker,
  type IncomingFile,
} from "./attachments.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "cctag-test-"));
}

const LIMITS = { maxFileBytes: 1024, maxFileCount: 2 };

test("WrittenFileTracker ignores a write whose permission prompt was denied", () => {
  const tracker = new WrittenFileTracker();
  // Shape verified against a real denied Write: the tool_use is recorded, then a
  // tool_result with is_error: true, and the target file is left untouched.
  tracker.ingest({
    writeRequests: [{ toolUseId: "toolu_denied", path: "/secrets/report.pdf" }],
    toolOutcomes: [{ toolUseId: "toolu_denied", ok: false }],
  });
  assert.deepEqual(tracker.paths(), []);
});

test("WrittenFileTracker keeps a write confirmed in a later poll batch", () => {
  const tracker = new WrittenFileTracker();
  // The tool_use and its tool_result routinely land in different batches, so
  // correlation has to survive across ingest() calls.
  tracker.ingest({ writeRequests: [{ toolUseId: "toolu_ok", path: "/out/chart.png" }] });
  assert.deepEqual(tracker.paths(), [], "not yet confirmed");
  tracker.ingest({ toolOutcomes: [{ toolUseId: "toolu_ok", ok: true }] });
  assert.deepEqual(tracker.paths(), [{ path: "/out/chart.png", origin: "write" }]);
});

test("WrittenFileTracker excludes a write whose outcome never arrived", () => {
  const tracker = new WrittenFileTracker();
  tracker.ingest({ writeRequests: [{ toolUseId: "toolu_pending", path: "/out/half.png" }] });
  tracker.ingest({ toolOutcomes: [{ toolUseId: "toolu_unrelated", ok: true }] });
  assert.deepEqual(tracker.paths(), []);
});

test("outbound extension filter excludes source and markdown", () => {
  assert.equal(isOutboundAttachable("/a/chart.png"), true);
  assert.equal(isOutboundAttachable("/a/doc.PDF"), true);
  assert.equal(isOutboundAttachable("/a/notes.md"), false);
  assert.equal(isOutboundAttachable("/a/index.ts"), false);
});

test("sanitizeAttachmentName strips traversal and control characters, keeps spaces and non-ASCII", () => {
  assert.equal(sanitizeAttachmentName("../../etc/pa\nss wd.png"), "pass wd.png");
  assert.equal(sanitizeAttachmentName("スクリーンショット 2026-07-27 14.02.33.png"), "スクリーンショット 2026-07-27 14.02.33.png");
  assert.equal(sanitizeAttachmentName("/"), "file");
});

test("buildPromptWithAttachments puts one path per line after the text", () => {
  const saved = [
    { path: "/in/a.png", name: "a.png", isImage: true },
    { path: "/in/b.pdf", name: "b.pdf", isImage: false },
  ];
  assert.equal(buildPromptWithAttachments("  見て  ", saved), "見て\n\n[Slackで添付されたファイル]\n/in/a.png\n/in/b.pdf");
  assert.equal(countImages(saved), 1);
});

test("saveIncomingFiles rejects an oversized file without transferring it", async () => {
  const dir = scratch();
  let fetched = 0;
  const files: IncomingFile[] = [{ id: "F_BIG", name: "big.png", size: LIMITS.maxFileBytes + 1 }];
  const result = await saveIncomingFiles(
    files,
    async () => {
      fetched++;
      return Buffer.alloc(1).toString("base64");
    },
    LIMITS,
    dir,
  );
  assert.equal(fetched, 0, "the declared size alone should be enough to refuse it");
  assert.deepEqual(result.saved, []);
  assert.equal(result.skipped.length, 1);
});

test("saveIncomingFiles rejects a file that lied about its size", async () => {
  const dir = scratch();
  const files: IncomingFile[] = [{ id: "F_LIAR", name: "liar.png", size: 1 }];
  const result = await saveIncomingFiles(files, async () => Buffer.alloc(LIMITS.maxFileBytes + 1).toString("base64"), LIMITS, dir);
  assert.deepEqual(result.saved, []);
  assert.equal(result.skipped.length, 1);
});

test("saveIncomingFiles honours the per-message count cap", async () => {
  const dir = scratch();
  const files: IncomingFile[] = [1, 2, 3].map((n) => ({ id: `F${n}`, name: `f${n}.png` }));
  const result = await saveIncomingFiles(files, async () => Buffer.from("x").toString("base64"), LIMITS, dir);
  assert.equal(result.saved.length, LIMITS.maxFileCount);
  assert.equal(result.skipped.length, 1);
});

test("outboxAdditions reports new and rewritten files, not untouched ones", () => {
  const cwd = scratch();
  const box = outboxDir(cwd);
  mkdirSync(box, { recursive: true });
  writeFileSync(join(box, "old.png"), "a");
  const baseline = snapshotOutbox(cwd);

  assert.deepEqual(outboxAdditions(cwd, baseline), [], "an untouched file is not an addition");

  writeFileSync(join(box, "new.png"), "b");
  assert.deepEqual(outboxAdditions(cwd, baseline), [join(box, "new.png")]);

  // Rewritten in place with the same length: mtime is what catches it.
  writeFileSync(join(box, "old.png"), "c");
  const future = new Date(Date.now() + 5_000);
  utimesSync(join(box, "old.png"), future, future);
  assert.deepEqual(outboxAdditions(cwd, baseline).sort(), [join(box, "new.png"), join(box, "old.png")].sort());
});

test("readOutboundAttachments dedupes a path reached by both outbound routes", () => {
  const cwd = scratch();
  const box = outboxDir(cwd);
  mkdirSync(box, { recursive: true });
  const p = join(box, "chart.png");
  writeFileSync(p, "png-bytes");
  // The same file arrives from SendUserFile and from the outbox scan. The
  // captioned entry is ordered first, which is how turn.ts feeds them.
  const { files } = readOutboundAttachments(
    [
      { path: p, origin: "send", caption: "グラフです" },
      { path: p, origin: "outbox" },
    ],
    LIMITS,
    cwd,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "chart.png");
  assert.equal(files[0].caption, "グラフです", "dedup must keep the caption, not the bare duplicate");
});

test("readOutboundAttachments resolves relative paths against the agent's cwd", () => {
  const cwd = scratch();
  writeFileSync(join(cwd, "rel.png"), "x");
  const { files } = readOutboundAttachments([{ path: "rel.png", origin: "send" }], LIMITS, cwd);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, join(cwd, "rel.png"));
});

test("readOutboundAttachments skips missing and empty files", () => {
  const cwd = scratch();
  writeFileSync(join(cwd, "empty.png"), "");
  const { files } = readOutboundAttachments(
    [
      { path: join(cwd, "empty.png"), origin: "send" },
      { path: join(cwd, "gone.png"), origin: "send" },
    ],
    LIMITS,
    cwd,
  );
  assert.deepEqual(files, []);
});
