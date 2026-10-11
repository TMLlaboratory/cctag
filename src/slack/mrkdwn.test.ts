import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToMrkdwn, segmentForSlack } from "./mrkdwn.js";
import { markdownTableBlock, markdownTableFallback } from "./blocks.js";

const kinds = (md: string): string[] => segmentForSlack(md).map((s) => s.kind);

test("segmentForSlack keeps prose and tables in their original order", () => {
  const md = ["前の文章", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "後の文章"].join("\n");
  // The regression this guards against is tables drifting to the end.
  assert.deepEqual(kinds(md), ["text", "table", "text"]);
  const segs = segmentForSlack(md);
  assert.match((segs[0] as { text: string }).text, /前の文章/);
  assert.match((segs[2] as { text: string }).text, /後の文章/);
});

test("segmentForSlack handles prose-table-prose-table without merging the tables", () => {
  const md = ["A", "", "| a |  b |", "|---|---|", "| 1 | 2 |", "", "B", "", "| c | d |", "|---|---|", "| 3 | 4 |"].join("\n");
  assert.deepEqual(kinds(md), ["text", "table", "text", "table"]);
});

test("segmentForSlack parses header and rows, padding ragged rows", () => {
  const md = ["| 名前 | 値 |", "|---|---|", "| あ | 1 |", "| い |"].join("\n");
  const table = (segmentForSlack(md)[0] as { table: { header: string[]; rows: string[][] } }).table;
  assert.deepEqual(table.header, ["名前", "値"]);
  assert.deepEqual(table.rows, [["あ", "1"], ["い", ""]]);
});

test("segmentForSlack leaves a pipe table inside a code fence as text", () => {
  const md = ["```", "| a | b |", "|---|---|", "| 1 | 2 |", "```"].join("\n");
  assert.deepEqual(kinds(md), ["text"]);
});

test("segmentForSlack does not treat prose containing a pipe as a table", () => {
  assert.deepEqual(kinds("a | b はパイプです"), ["text"]);
});

test("markdownTableBlock renders inline formatting in cells", () => {
  const block = markdownTableBlock({
    header: ["項目", "値"],
    rows: [["**太字**", "`code`"], ["[link](https://example.com)", "*斜体*"]],
  }) as { type: string; rows: unknown[][] };
  assert.equal(block.type, "table");
  assert.equal(block.rows.length, 3, "header + 2 rows");
  const json = JSON.stringify(block);
  // Verified against a live workspace: cells are not plain-text-only.
  assert.match(json, /"bold":true/);
  assert.match(json, /"code":true/);
  assert.match(json, /"italic":true/);
  assert.match(json, /"type":"link"/);
  assert.doesNotMatch(json, /\*\*/, "markdown markers must not survive into the cell text");
});

test("markdownTableBlock refuses a table past the documented caps", () => {
  const wide = { header: Array.from({ length: 21 }, (_, i) => `c${i}`), rows: [] };
  assert.equal(markdownTableBlock(wide), null, "21 columns");
  const tall = { header: ["a"], rows: Array.from({ length: 100 }, () => ["x"]) };
  assert.equal(markdownTableBlock(tall), null, "101 rows including the header");
  const fat = { header: ["a"], rows: [["x".repeat(10_001)]] };
  assert.equal(markdownTableBlock(fat), null, "over 10,000 characters");
});

test("an oversized table falls back to a monospace grid rather than being dropped", () => {
  const table = { header: ["名前", "値"], rows: [["あ", "1"], ["ううう", "22"]] };
  const out = markdownTableFallback(table);
  assert.match(out, /^```/);
  assert.match(out, /ううう/);
  assert.match(out, /22/);
});

test("a rejected block post falls back to text instead of losing the turn's output", async () => {
  const { postSegmented } = await import("./post.js");
  const replies: string[] = [];
  const notifier = {
    async postMessage() {
      // What Slack does when a block fails validation.
      throw new Error("invalid_blocks");
    },
    async postReply(_c: string, _t: string, text: string) {
      replies.push(text);
    },
  };
  const md = ["答えです。", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
  await postSegmented(notifier as never, "C1", "", md);
  assert.equal(replies.length, 1, "the answer must still reach the thread");
  assert.match(replies[0], /答えです/);
  assert.match(replies[0], /```/, "the table degrades to a monospace grid");
});

const Z = "​";

test("markdownToMrkdwn keeps bold as bold instead of turning it into italic", () => {
  // The italic pass used to rewrite the `*x*` the bold pass had just produced.
  assert.equal(markdownToMrkdwn("this is **bold** text"), "this is *bold* text");
  assert.equal(markdownToMrkdwn("- **項目** の説明"), "• *項目* の説明");
});

test("markdownToMrkdwn puts a zero-width space where Slack would see no boundary", () => {
  // Checked in a live thread: `これは*太字*です` and `「*太字*」` show the
  // asterisks; spaces, line edges and a zero-width space all render bold.
  assert.equal(markdownToMrkdwn("これは**太字**です"), `これは${Z}*太字*${Z}です`);
  assert.equal(markdownToMrkdwn("「**太字**」"), `「${Z}*太字*${Z}」`);
  assert.equal(markdownToMrkdwn("これは **太字** です"), "これは *太字* です");
  assert.equal(markdownToMrkdwn("**太字**"), "*太字*");
});

test("markdownToMrkdwn still converts italic, alongside bold on the same line", () => {
  assert.equal(markdownToMrkdwn("*斜体* と **太字**"), "_斜体_ と *太字*");
});

test("markdownToMrkdwn does not nest bold inside a heading", () => {
  // A heading is already a bold line; `**` inside it would leave `**x**`.
  assert.equal(markdownToMrkdwn("## **見出し**の続き"), "*見出しの続き*");
});

test("markdownToMrkdwn leaves inline code alone", () => {
  // Seen live: `**x**` in code came out as `*x*`, and a lone `*` in code
  // paired with a later one and broke the span.
  assert.equal(markdownToMrkdwn("`**x**` は太字"), "`**x**` は太字");
  assert.equal(markdownToMrkdwn("`*` が文字のまま、`_太字_` に"), "`*` が文字のまま、`_太字_` に");
  assert.equal(markdownToMrkdwn("`*` と **太字** と `*`"), "`*` と *太字* と `*`");
});

test("markdownToMrkdwn leaves asterisks in a code fence alone", () => {
  const md = ["```", "**not bold**", "```"].join("\n");
  assert.equal(markdownToMrkdwn(md), md);
});

test("segmentForSlack keeps every text segment within a section block's 3,000 characters", () => {
  // A long bilingual reply: one run of prose between 3,000 and 3,900 characters
  // used to land in a single section and fail the post with `invalid_blocks`.
  const md = `${"あ".repeat(1400)}\n\n---\n\n${"word ".repeat(400)}`;
  const texts = segmentForSlack(md).map((s) => (s.kind === "text" ? s.text : ""));
  assert.ok(texts.length > 1);
  for (const t of texts) assert.ok(t.length <= 3000, `segment of ${t.length} characters`);
  const joined = texts.join("");
  assert.equal(joined.match(/あ/g)?.length, 1400);
  assert.equal(joined.match(/word/g)?.length, 400);
});

test("segmentForSlack keeps a split code fence within a section block, markers included", () => {
  const md = "```\n" + "x".repeat(80).concat("\n").repeat(60) + "```";
  for (const s of segmentForSlack(md)) if (s.kind === "text") assert.ok(s.text.length <= 3000);
});
